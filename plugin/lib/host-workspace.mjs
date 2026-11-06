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
 * 本文件 T1 阶段只装配：目录初始化（.team-workplace 四分区）+ gitignore 托管块 + 服务骨架。
 */
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/** .team-workplace 分区常量（PRD §4.1，FR-9.3） */
export const WORKPLACE_DIRS = {
  root: '.team-workplace',
  config: 'config',
  configRoles: 'config/roles',
  configPresets: 'config/presets',
  state: 'state',
  stateLogs: 'state/logs',
  stateScratch: 'state/scratch',
  stateTeams: 'state/teams',
  archive: 'archive',
  export: 'export',
}

const GITIGNORE_MARK_BEGIN = '# >>> dsh-plugin-myteam managed block >>>'
const GITIGNORE_MARK_END = '# <<< dsh-plugin-myteam managed block <<<'

/** 托管块忽略项（R11：只追加不修改用户已有行；幂等） */
const MANAGED_IGNORES = [
  '.team-workplace/state/',
  '.team-workplace/archive/',
]

/**
 * 幂等维护 .gitignore 托管块（TF 收口提交防线简化版）。
 * - 已有托管块 → 不动（幂等）
 * - 无托管块 → 文件尾部追加（含前导空行）；检测到用户已有等价忽略规则时仍写入托管块
 *   （重复忽略无害），但告警日志记录冲突（R11 缓解：尊重用户规则语义——托管块永不删除用户行）
 */
export function ensureGitignoreManagedBlock(workspaceRoot        , warn                            = () => {})                       {
  const gitignorePath = join(workspaceRoot, '.gitignore')
  let existing = ''
  try {
    existing = readFileSync(gitignorePath, 'utf8')
  } catch {
    // 无 .gitignore：创建仅含托管块的文件
  }
  if (existing.includes(GITIGNORE_MARK_BEGIN)) return { changed: false }
  const blockLines = [
    GITIGNORE_MARK_BEGIN,
    ...MANAGED_IGNORES,
    GITIGNORE_MARK_END,
  ]
  const sep = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  const next = `${existing}${sep}${blockLines.join('\n')}\n`
  writeFileSync(gitignorePath, next, 'utf8')
  for (const line of MANAGED_IGNORES) {
    const userHasEquivalent = existing
      .split('\n')
      .some((l) => l.trim() === line && !l.startsWith('#'))
    if (userHasEquivalent) warn(`gitignore: user rule already covers ${line}; managed block added redundantly`)
  }
  return { changed: true }
}

/**
 * 初始化 .team-workplace 四分区（幂等）。
 * 注意 R26（T0 环境发现）：目录创建只允许在本插件服务内（host 进程）执行；
 * 成员 scratch 子目录由成员首次写入时自建（<teamId>/<member>/ 两级），host 不预创建。
 *
 * CHG-86（P1 缺陷）：旧实现 `resolve(workspaceRoot, dir)` 只拼**工作区根**，把
 * `config/ state/ archive/ export/` 四个分区建到了工作区**根目录**下（污染用户项目，
 * 且 `.team-workplace/archive` 从未被创建 → 归档落盘必失败）。改为 `join(root, dir)`：
 * 除 `root` 自身（'.team-workplace'）外的分区都挂在 `.team-workplace/` 下（FR-9.3）。
 */
export function ensureWorkplaceDirs(workspaceRoot        , warn                            = () => {})                                      {
  const root = resolve(workspaceRoot, WORKPLACE_DIRS.root)
  const created           = []
  for (const dir of Object.values(WORKPLACE_DIRS)) {
    // 分区路径：'.team-workplace' 是根自身；其余挂在根下（config → .team-workplace/config）
    const target = dir === WORKPLACE_DIRS.root ? root : resolve(root, dir)
    if (!existsSync(target)) {
      mkdirSync(target, { recursive: true })
      created.push(dir)
    }
  }
  if (!existsSync(join(root, 'structure.md'))) {
    writeFileSync(
      join(root, 'structure.md'),
      '# structure.md（队长维护的项目结构约定）\n\n> 队长在结构整理职责（FR-10.1）下维护本文件：文件放哪里、做到什么程度、谁沟通、谁存档。\n',
      'utf8',
    )
  }
  return { root, created }
}

/** 最小 Cordis 上下文面（本文件只用到这两处；完整类型在 src/host.ts 的 HostRuntime） */
                        
                               
                                                                                 
 

/** T1：宿主插件装配入口。TS 完整版在 src/host.ts（T7 前补齐工具注册）。 */
export default function activate(ctx              ) {
  const workspaceRoot = ctx?.workspace?.root ?? process.cwd()
  const warn = (msg        ) => ctx?.logger?.warn?.(`[myteam] ${msg}`) ?? console.warn(`[myteam] ${msg}`)

  const dirs = ensureWorkplaceDirs(workspaceRoot, warn)
  const gitignore = ensureGitignoreManagedBlock(workspaceRoot, warn)

  ctx?.logger?.info?.(
    `[myteam] workplace ready at ${dirs.root} (created: ${dirs.created.length}), gitignore block ${gitignore.changed ? 'added' : 'present'}`,
  )

  return {
    // T2 起逐步挂载：ledger / scheduler / members / roles / tools / remote
    __workplace: dirs,
  }
}


//# sourceURL=file:///E:/Workplace/extension/dsh-myteam/plugin/src/host-workspace.ts