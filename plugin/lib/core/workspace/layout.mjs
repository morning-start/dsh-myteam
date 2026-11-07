/**
 * 项目级存储布局（CHG-102）——**唯一事实源**。
 *
 * 背景（用户定案 2026-11-07）：
 *   「把所有的内容放在项目级别下的一个 `.dsh-myteam` 这个文件夹下，通过配置文件和一些
 *    配置驱动的文件，保存：① 角色、团队、技能、工具；② 任务及任务依赖；③ 整体的流程过程。
 *    另外要明确哪些内容能上传、哪些不能上传，需要在该文件夹下设置一个 `.gitignore` 文件。」
 *
 * 在此之前，路径散落在 20 个模块里（`.team-workplace` 硬编码 30 余处），并且宿主把
 * 「工作区根」解析成了 DSH profile 目录（`~/.dsh/profiles/desktop`）——于是**项目级角色
 * 写进了用户全局 profile**，面板的项目视图永远看不到它们。本模块把这两件事一起收口：
 *
 *   ① 目录布局只有这一份定义（`storeLayout()`），其它模块一律从这里取路径；
 *   ② 项目根只能由 `resolveProjectRoot()` 解析，DSH profile / 家目录**永远不是项目**。
 *
 * ── 目录契约（v1） ────────────────────────────────────────────────
 *
 *   <project>/.dsh-myteam/
 *   ├── .gitignore                 # 本目录自己的提交纪律（哪些能上传）
 *   ├── manifest.json              # 项目清单：schema 版本 / 项目名 / 默认团队
 *   ├── README.md                  # 目录说明（人读）
 *   ├── structure.md               # 团队章程（队长维护的项目结构约定）
 *   ├── config/                    # ① 配置资产 —— 入库、可 review、可共享
 *   │   ├── team.config.json       #    行为配置（看板列 / 泳道 / 门禁 / 限制）
 *   │   ├── workflow.json          #    整体流程：阶段 + 门禁链 + 交接规则
 *   │   ├── project-role.json      #    项目自身角色（不属于任何团队）
 *   │   ├── session-defaults.json  #    单角色调用（/myteam+id）的会话默认值
 *   │   ├── roles/<roleId>.json    #    角色
 *   │   ├── teams/<teamId>.json    #    团队（名册模板）
 *   │   ├── skills/<skillId>.json  #    项目技能
 *   │   ├── tools/<toolId>.json    #    工具策略（只能收窄）
 *   │   └── knowledge/             #    团队知识库（index.json + <topic>.md）
 *   ├── tasks/                     # ② 任务及依赖 —— 入库
 *   │   └── <teamId>/ledger.jsonl  #    append-only 账本（任务/依赖的唯一权威）
 *   ├── history/                   # ③ 整体流程过程 —— 不入库
 *   │   ├── archive/<teamId>/      #    归档快照
 *   │   ├── tokens/<teamId>.json   #    token 计量侧车
 *   │   └── members/<teamId>/<memberId>/memory/   # 成员私有记忆
 *   ├── state/                     # 运行时派生数据 —— 不入库
 *   │   ├── teams.json             #    工作区索引（可从账本重建）
 *   │   ├── scratch/<teamId>/<memberId>/
 *   │   └── logs/
 *   └── export/                    # 导出快照 —— 不入库
 *
 * 纪律：
 *   - **路径只从 `storeLayout()` 取**，不要在别处再拼 `.dsh-myteam`；
 *   - 初始化幂等（`ensureStore` 可重复调用），只补缺，不覆盖已有文件；
 *   - 旧目录 `.team-workplace` 走一次性迁移（`migrateLegacyStore`），迁移后保留备份名。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

/* ── 常量 ─────────────────────────────────────────────────────── */

/** 项目级存储根目录名（用户定案：与插件包名 `dsh-plugin-myteam` 对齐） */
export const STORE_DIR = '.dsh-myteam'
/** 旧目录名（CHG-3 曾改名 `.team-workplace`；CHG-102 起回到 `.dsh-myteam`） */
export const LEGACY_STORE_DIR = '.team-workplace'
/** 布局版本：目录结构变化时 +1（写进 manifest.json，迁移按版本判） */
export const LAYOUT_VERSION = 1
export const SCHEMA_VERSION = 1

/** 目录布局（全部为绝对路径；`storeLayout()` 的返回值） */
                              
                                
              
                  
                
                   
                 
                            
                
                    
                  
                     
                         
               
               
                
               
                   
                            
               
                               
                 
                 
                
                 
                            
               
                    
                 
              
                  
                   
 

/** 布局单一事实源：所有路径都从这里派生 */
export function storeLayout(projectRoot        )              {
  const root = resolve(projectRoot, STORE_DIR)
  const config = join(root, 'config')
  const tasks = join(root, 'tasks')
  const history = join(root, 'history')
  const state = join(root, 'state')
  return {
    root,
    manifest: join(root, 'manifest.json'),
    readme: join(root, 'README.md'),
    gitignore: join(root, '.gitignore'),
    charter: join(root, 'structure.md'),
    config,
    teamConfig: join(config, 'team.config.json'),
    workflow: join(config, 'workflow.json'),
    projectRole: join(config, 'project-role.json'),
    sessionDefaults: join(config, 'session-defaults.json'),
    roles: join(config, 'roles'),
    teams: join(config, 'teams'),
    skills: join(config, 'skills'),
    tools: join(config, 'tools'),
    knowledge: join(config, 'knowledge'),
    tasks,
    history,
    archive: join(history, 'archive'),
    tokens: join(history, 'tokens'),
    members: join(history, 'members'),
    state,
    stateIndex: join(state, 'teams.json'),
    scratch: join(state, 'scratch'),
    logs: join(state, 'logs'),
    exportDir: join(root, 'export'),
  }
}

/* ── 团队级路径（都有一个参数化入口，避免调用点自己拼） ───────────── */

/** 团队目录（任务与依赖）：`tasks/<teamId>/` */
export function teamTasksDir(projectRoot        , teamId        )         {
  return join(storeLayout(projectRoot).tasks, teamId)
}

/** 账本路径：`tasks/<teamId>/ledger.jsonl`（任务/依赖唯一权威） */
export function teamLedgerPath(projectRoot        , teamId        )         {
  return join(teamTasksDir(projectRoot, teamId), 'ledger.jsonl')
}

/** 团队运行期生效配置：`tasks/<teamId>/team.config.json`（建团时按模板落盘） */
export function teamConfigPath(projectRoot        , teamId        )         {
  return join(teamTasksDir(projectRoot, teamId), 'team.config.json')
}

/** 归档目录：`history/archive/<teamId>/` */
export function teamArchiveDir(projectRoot        , teamId        )         {
  return join(storeLayout(projectRoot).archive, teamId)
}

/** 归档根：`history/archive/` */
export function archiveRoot(projectRoot        )         {
  return storeLayout(projectRoot).archive
}

/** token 侧车：`history/tokens/<teamId>.json` */
export function teamTokensPath(projectRoot        , teamId        )         {
  return join(storeLayout(projectRoot).tokens, `${teamId}.json`)
}

/** 成员身份快照目录：`history/members/<teamId>/<memberId>`（identity.json 的落点） */
export function memberIdentityDir(projectRoot        , teamId        , memberId        )         {
  return join(storeLayout(projectRoot).members, teamId, memberId)
}

/** 成员记忆目录：`history/members/<teamId>/<memberId>/memory` */
export function memberMemoryDir(projectRoot        , teamId        , memberId        )         {
  return join(storeLayout(projectRoot).members, teamId, memberId, 'memory')
}

/** 临时脚本区：`state/scratch/<teamId>/<memberId>` */
export function scratchDir(projectRoot        , teamId        , memberId         )         {
  const base = join(storeLayout(projectRoot).scratch, teamId)
  return memberId ? join(base, memberId) : base
}

/** 账本相对路径（写进事件/快照的展示串，永远用 `/`） */
export function teamLedgerRelative(teamId        )         {
  return `${STORE_DIR}/tasks/${teamId}/ledger.jsonl`
}

/* ── 项目根解析 ───────────────────────────────────────────────── */

                                       
                             
                   
                                                                
                     
                                                
                        
                     
              
 

                                        
              
                   
                                                    
                                              
                                                                   
 

function dshHome(env                    = process.env)         {
  const home = env.DSH_HOME || env.DSH_HOME_DIR
  return home ? resolve(home) : join(homedir(), '.dsh')
}

/** 归一化后判断 `child` 是否在 `parent` 目录内（大小写不敏感，Windows 友好） */
function isInside(child        , parent        )          {
  const a = normalize(child).replace(/[\\/]+$/, '').toLowerCase()
  const b = normalize(parent).replace(/[\\/]+$/, '').toLowerCase()
  if (a === b) return true
  return a.startsWith(`${b}${sep}`) || a.startsWith(`${b}/`)
}

/**
 * 候选路径是否**不是**项目根。
 *
 * 为什么这条规则是硬的：DSH 宿主里 `ctx.workspace.root` 在 desktop profile 下解析成
 * `~/.dsh/profiles/desktop`——项目级角色于是写进了用户全局 profile（CHG-102 修的正是
 * 这个 P0）。这类路径一律拒绝，宁可回退到会话 cwd 并大声告警。
 */
export function rejectProjectRoot(path        , env                    = process.env)                     {
  if (typeof path !== 'string' || path.trim().length === 0) return 'empty path'
  if (!isAbsolute(path)) return 'not an absolute path'
  const home = dshHome(env)
  const normalized = resolve(path)
  if (isInside(normalized, home)) {
    // `~/.dsh/profiles/<name>` 是宿主 profile：它的 `.dsh-myteam` 不属于任何项目
    return `inside DSH home (${home}) — profile dirs are not projects`
  }
  if (isInside(normalized, homedir())) {
    // 家目录本身可以是项目（用户可能就在 home 下开工），但 `~/.dsh` 之外也挡一层噪音目录
    const base = basename(normalized).toLowerCase()
    if (base === 'appdata' || base === 'temp' || base === 'tmp') return `system temp/cache dir (${normalized})`
  }
  return undefined
}

/**
 * 解析项目根：**会话工作目录 > 显式配置 > 宿主 workspace > 进程 cwd**。
 *
 * 顺序理由：工具/面板跑在某个会话里，会话 cwd 就是用户打开的那个项目；宿主的
 * `workspace.root` 在 desktop profile 下是 profile 目录，只能当兜底且必须先过
 * `rejectProjectRoot`。
 */
export function resolveProjectRoot(candidates                      , env                    = process.env)                        {
  const rejected                                    = []
  const tryCandidate = (source                                 , path                    )                     => {
    if (!path) return undefined
    const reason = rejectProjectRoot(path, env)
    if (reason) {
      rejected.push({ source, path, reason })
      return undefined
    }
    return resolve(path)
  }
  const session = tryCandidate('session', candidates.sessionCwd)
  if (session) return { root: session, source: 'session', rejected }
  const explicit = tryCandidate('config', candidates.explicit)
  if (explicit) return { root: explicit, source: 'config', rejected }
  const workspace = tryCandidate('workspace', candidates.workspaceRoot)
  if (workspace) return { root: workspace, source: 'workspace', rejected }
  const cwd = tryCandidate('cwd', candidates.cwd ?? process.cwd())
  if (cwd) return { root: cwd, source: 'cwd', rejected }
  return { root: resolve(process.cwd()), source: 'cwd', rejected }
}

/* ── 初始化 / 迁移 ───────────────────────────────────────────── */

/** 目录分区（相对 store 根；顺序即创建顺序） */
const STORE_DIRS = [
  'config',
  'config/roles',
  'config/teams',
  'config/skills',
  'config/tools',
  'config/knowledge',
  'tasks',
  'history',
  'history/archive',
  'history/tokens',
  'history/members',
  'state',
  'state/scratch',
  'state/logs',
  'export',
]         

/**
 * `.dsh-myteam/.gitignore` 的内容——**这是「哪些能上传」的唯一权威**。
 *
 * 为什么放在目录里面而不是项目根：用户明确要求「在该文件夹下设置一个 .gitignore」。
 * 放到根 `.gitignore` 会让「团队存储」污染用户项目的忽略规则（旧实现就是这么干的，
 * 而且它还会在宿主 profile 目录里生成一条 `.team-workplace/` 的垃圾规则）。
 */
export const STORE_GITIGNORE = `# >>> dsh-plugin-myteam managed block >>>
# 本文件由插件幂等维护，请勿手改本块。
#
# 能上传（随仓库共享、可 review）：
#   manifest.json  README.md  structure.md
#   config/        ← 角色 / 团队 / 技能 / 工具 / 流程 / 知识
#   tasks/         ← 任务及依赖（append-only 账本）
#
# 不能上传（运行时状态与历史流水，clone 后自动重建）：
state/
history/
export/
*.tmp
.tmp/
# <<< dsh-plugin-myteam managed block <<<
`

/** 旧实现写在项目根 `.gitignore` 里的托管块（迁移时清掉，避免两处规则打架） */
const LEGACY_GITIGNORE_BEGIN = '# >>> dsh-plugin-myteam managed block >>>'
const LEGACY_GITIGNORE_END = '# <<< dsh-plugin-myteam managed block <<<'

/** `.dsh-myteam/README.md`：目录说明（人读；只在缺失时写，用户可改） */
export const STORE_README = `# .dsh-myteam —— 项目级团队存储

本目录是 myteam 的**项目级唯一落盘根**：角色、团队、技能、工具、任务依赖、流程配置
都在这里，随项目走，不落到用户全局 profile。

## 目录

| 路径 | 内容 | 上传 |
|---|---|---|
| \`manifest.json\` | 项目清单（schema 版本 / 项目名 / 默认团队） | ✅ |
| \`config/team.config.json\` | 行为配置（看板列 / 泳道 / 门禁 / 限制） | ✅ |
| \`config/workflow.json\` | 整体流程（阶段 + 门禁链 + 交接规则） | ✅ |
| \`config/roles/<roleId>.json\` | 角色（职责 / 提示词 / 工具策略 / 技能 / MCP） | ✅ |
| \`config/teams/<teamId>.json\` | 团队（名册模板） | ✅ |
| \`config/skills/<skillId>.json\` | 项目技能 | ✅ |
| \`config/tools/<toolId>.json\` | 工具策略（只能收窄权限） | ✅ |
| \`config/knowledge/\` | 团队知识库（\`index.json\` + 主题条目） | ✅ |
| \`tasks/<teamId>/ledger.jsonl\` | 任务与依赖的 append-only 账本（唯一权威） | ✅ |
| \`structure.md\` | 团队章程（队长维护的结构约定） | ✅ |
| \`history/\` | 归档 / token 计量 / 成员记忆 | ❌ |
| \`state/\` | 索引 / scratch / 日志（可从账本重建） | ❌ |
| \`export/\` | 导出快照 | ❌ |

## 规矩

1. **只改 \`config/\` 与 \`tasks/\` 里你懂的东西**；\`state/\` 删掉不会丢数据（可重建）。
2. 想让别人共享你的团队：提交 \`config/\`（\`.gitignore\` 已经放行）。
3. 别把凭据写进来——\`config/\` 是入库的。
`

/** 写入策略：只在缺失时写（用户改过的不覆盖） */
function writeIfMissing(path        , content        )          {
  if (existsSync(path)) return false
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return true
}

                                    
                     
                            
                   
                                           
                   
                    
 

/**
 * 初始化项目级存储（幂等）。
 *
 * - 目录分区缺失就补（不删任何东西）；
 * - `.gitignore` / `README.md` / `manifest.json` / `structure.md` 只在缺失时写；
 * - 存在旧目录 `.team-workplace` 且新目录还不存在 → 整目录迁移（rename），失败则复制降级并告警。
 */
export function ensureStore(projectRoot        , opts                                                          = {})                    {
  const warn = opts.warn ?? (() => {})
  const layout = storeLayout(projectRoot)
  const created           = []
  const warnings           = []
  let migrated = false

  if (opts.migrate !== false) {
    const result = migrateLegacyStore(projectRoot, warn)
    migrated = result.migrated
    warnings.push(...result.warnings)
  }

  mkdirSync(layout.root, { recursive: true })
  for (const dir of STORE_DIRS) {
    const target = join(layout.root, dir)
    if (!existsSync(target)) {
      mkdirSync(target, { recursive: true })
      created.push(dir)
    }
  }

  writeIfMissing(layout.gitignore, STORE_GITIGNORE)
  writeIfMissing(layout.readme, STORE_README)
  writeIfMissing(layout.charter, '# structure.md（队长维护的项目结构约定）\n\n> 队长在结构整理职责（FR-10.1）下维护本文件：文件放哪里、做到什么程度、谁沟通、谁存档。\n')
  writeIfMissing(
    layout.manifest,
    `${JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        layoutVersion: LAYOUT_VERSION,
        layout: `${STORE_DIR}/v${LAYOUT_VERSION}`,
        projectName: basename(resolve(projectRoot)),
        createdAt: new Date().toISOString(),
        defaultTeamId: 'default',
      },
      null,
      2,
    )}\n`,
  )
  // 旧实现把托管块写进了项目根 .gitignore（污染用户仓库）——迁移时清掉
  const legacyCleaned = removeLegacyGitignoreBlock(projectRoot)
  if (legacyCleaned) warnings.push('removed legacy managed block from project root .gitignore')
  for (const warning of warnings) warn(warning)
  return { layout, created, migrated, warnings }
}

/**
 * 旧目录迁移：`.team-workplace` → `.dsh-myteam`（一次性，幂等）。
 *
 * 为什么 rename 而不是复制：账本可能很大（append-only），复制既慢又容易半途失败；
 * rename 在同一卷上是原子的。跨设备失败时降级为「保留旧目录 + 告警」——不静默丢数据。
 */
export function migrateLegacyStore(projectRoot        , warn                            = () => {})                                            {
  const warnings           = []
  const next = storeLayout(projectRoot).root
  const legacy = resolve(projectRoot, LEGACY_STORE_DIR)
  if (!existsSync(legacy)) return { migrated: false, warnings }
  if (existsSync(next)) {
    warnings.push(`legacy ${LEGACY_STORE_DIR} ignored: ${STORE_DIR} already exists (delete the old dir manually if stale)`)
    return { migrated: false, warnings }
  }
  try {
    renameSync(legacy, next)
    // 旧布局的 `config/presets/` 与新布局 `config/teams/` 对齐（rename 后补一步）
    const oldPresets = join(next, 'config', 'presets')
    const newTeams = join(next, 'config', 'teams')
    if (existsSync(oldPresets) && !existsSync(newTeams)) renameSync(oldPresets, newTeams)
    warnings.push(`migrated ${LEGACY_STORE_DIR} → ${STORE_DIR}`)
    warn(`migrated ${LEGACY_STORE_DIR} → ${STORE_DIR}`)
    return { migrated: true, warnings }
  } catch (e) {
    warnings.push(`legacy migration failed (${String((e                        ).message ?? e)}); ${LEGACY_STORE_DIR} left in place`)
    warn(`legacy migration failed: ${String(e)}`)
    return { migrated: false, warnings }
  }
}

/** 清掉旧实现写在项目根 `.gitignore` 的托管块（只删自己那几行，保留用户规则） */
export function removeLegacyGitignoreBlock(projectRoot        )          {
  const path = join(projectRoot, '.gitignore')
  if (!existsSync(path)) return false
  let text        
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  const begin = text.indexOf(LEGACY_GITIGNORE_BEGIN)
  if (begin < 0) return false
  const end = text.indexOf(LEGACY_GITIGNORE_END, begin)
  const tail = end < 0 ? '' : text.slice(end + LEGACY_GITIGNORE_END.length)
  const head = text.slice(0, begin)
  const next = `${head.replace(/\s+$/, '')}${head.trim() ? '\n' : ''}${tail.replace(/^\s*\n/, '')}`.replace(/\n{3,}/g, '\n\n')
  try {
    if (next.trim().length === 0) rmSync(path)
    else writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 存储是否已初始化（面板空态判定：未初始化 = 还没进过团队模式） */
export function isStoreInitialized(projectRoot        )          {
  if (!projectRoot || !isAbsolute(projectRoot)) return false
  const layout = storeLayout(projectRoot)
  return existsSync(layout.root) && existsSync(layout.manifest)
}

/** 读取项目清单（缺失/损坏返回 undefined；面板只读） */
export function readManifest(projectRoot        )                                      {
  const layout = storeLayout(projectRoot)
  if (!existsSync(layout.manifest)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(layout.manifest, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed                           ) : undefined
  } catch {
    return undefined
  }
}

/**
 * 展示用路径（CHG-107，用户定案）：「用户名不该显示，应显示 ~」。
 *
 * 面板里到处显示绝对路径（`$HOME/.dsh/myteam/plugins`）有两个问题：
 *  1. 泄露本机账户名（截图 / 录屏 / 提 issue 时尤其糟糕）；
 *  2. 太长，挤占本来就紧的横排空间。
 *
 * 规则：路径在 `$HOME` 内 → 前缀换成 `~`（`~/` 或 `~\`）；不在 `$HOME` 内 → 原样返回。
 * **只用于展示**——`title` 里仍保留真实绝对路径，方便复制与排障。
 */
export function displayPath(absPath        , env                    = process.env)         {
  if (!absPath) return absPath
  const home = env.USERPROFILE || env.HOME || homedir()
  if (!home) return absPath
  try {
    const rel = relative(resolve(home), resolve(absPath))
    if (rel === '') return '~'
    if (rel.startsWith('..') || isAbsolute(rel)) return absPath
    return `~${sep}${rel}`
  } catch {
    return absPath
  }
}


//# sourceURL=./src/core/workspace/layout.ts