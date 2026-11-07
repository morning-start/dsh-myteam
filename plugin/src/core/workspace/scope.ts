/**
 * 作用域契约（CHG-103）——**哪些内容能存在全局，哪些只能是项目级**。
 *
 * 用户定案（2026-11-07）：
 *   「任务、历史、状态这些内容只有项目级别才有，全局级别只有团队、角色和角色内的东西，
 *     knowledge 也可以有。你要分清楚，有一些很明显的东西，比如说历史、状态、导出，
 *     这些明显就是项目级别的任务。所以你在处理的时候，只能用项目级别去管理这个东西。」
 *
 * 为什么需要这层守卫（而不是靠约定）：
 *   - 账本（tasks/）是**单写者 append-only** 的，全局共享账本会让两个项目的 taskId 撞车；
 *   - 历史/状态/导出是**运行时产物**，跨项目共享没有语义（谁的状态？）；
 *   - 全局库是**跨项目资产**（角色 / 团队 / 技能 / 工具 / 知识），只读语义强、可复制不可变。
 *
 * 因此：`assertWritableAtScope(scope, kind)` 在**任何写路径**上调用；
 * 项目级专属的 kind 传 `global` 一律 `MT_SCOPE_PROJECT_ONLY`（拒绝式，附「应该去哪」）。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { storeLayout } from './layout.ts'

export type Scope = 'project' | 'global'

/** 可写入的内容种类（与目录契约一一对应） */
export type ScopeKind =
  | 'roles'
  | 'teams'
  | 'skills'
  | 'tools'
  | 'knowledge'
  | 'teamConfig'
  | 'workflow'
  | 'tasks'
  | 'history'
  | 'state'
  | 'export'
  | 'members'

/** 全局允许的内容（用户定案）：团队、角色、角色内的东西（技能/工具）、知识 */
export const GLOBAL_KINDS: readonly ScopeKind[] = ['roles', 'teams', 'skills', 'tools', 'knowledge']

/** 项目级专属：任务账本 / 历史 / 状态 / 导出 / 成员实例 / 团队运行期配置 / 流程 */
export const PROJECT_ONLY_KINDS: readonly ScopeKind[] = ['tasks', 'history', 'state', 'export', 'members', 'teamConfig', 'workflow']

export class ScopeError extends Error {
  code: 'MT_SCOPE_INVALID' | 'MT_SCOPE_PROJECT_ONLY'
  detail?: unknown
  constructor(code: ScopeError['code'], message: string, detail?: unknown) {
    super(message)
    this.name = 'ScopeError'
    this.code = code
    this.detail = detail
  }
}

/** 归一化作用域：缺省 = 项目级（**全局必须明示**，用户第 3 条） */
export function normalizeScope(raw: unknown): Scope {
  if (raw === undefined || raw === null || raw === '') return 'project'
  if (raw === 'project' || raw === 'global') return raw
  throw new ScopeError('MT_SCOPE_INVALID', `unknown scope "${String(raw)}"; 只接受 project | global（缺省 project）`)
}

/** 全局资产根：`$DSH_HOME/myteam`（跨项目，**不含** tasks/history/state/export） */
export function globalRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'myteam')
}

/**
 * 某类内容在某个作用域下的落点。
 *
 * 项目级走 `storeLayout()`（唯一布局事实源）；全局级只有五个子目录，
 * 且**永远不出现** `tasks/` `history/` `state/` `export/`。
 */
export function scopeDir(projectRoot: string, scope: Scope, kind: ScopeKind, env: NodeJS.ProcessEnv = process.env): string {
  assertWritableAtScope(scope, kind)
  if (scope === 'global') return join(globalRoot(env), kind === 'knowledge' ? 'knowledge' : kind)
  const layout = storeLayout(projectRoot)
  switch (kind) {
    case 'roles':
      return layout.roles
    case 'teams':
      return layout.teams
    case 'skills':
      return layout.skills
    case 'tools':
      return layout.tools
    case 'knowledge':
      return layout.knowledge
    case 'teamConfig':
      return layout.tasks
    case 'workflow':
      return layout.config
    case 'tasks':
      return layout.tasks
    case 'history':
      return layout.history
    case 'state':
      return layout.state
    case 'export':
      return layout.exportDir
    case 'members':
      return layout.members
  }
}

/** 写路径守卫：项目级专属内容写进全局 → 拒绝并说明该去哪 */
export function assertWritableAtScope(scope: Scope, kind: ScopeKind): void {
  if (scope === 'global' && !GLOBAL_KINDS.includes(kind)) {
    throw new ScopeError(
      'MT_SCOPE_PROJECT_ONLY',
      `"${kind}" is project-level only（全局只有 ${GLOBAL_KINDS.join(' / ')}）；请改用项目作用域`,
      { scope, kind, allowed: GLOBAL_KINDS },
    )
  }
}

/** 面板/文档展示用的作用域矩阵（纯数据，无 IO） */
export function scopeMatrix(): Array<{ kind: ScopeKind; scope: Scope; note: string }> {
  return [
    { kind: 'roles', scope: 'global', note: '全局角色库（跨项目可见；默认只建项目级，全局须明示）' },
    { kind: 'teams', scope: 'global', note: '全局团队模板（开箱队形）' },
    { kind: 'skills', scope: 'global', note: '技能定义' },
    { kind: 'tools', scope: 'global', note: '工具策略（只收窄）' },
    { kind: 'knowledge', scope: 'global', note: '共享知识条目' },
    { kind: 'teamConfig', scope: 'project', note: '团队运行期配置（看板列/门禁）' },
    { kind: 'workflow', scope: 'project', note: '整体流程（阶段 + 交接）' },
    { kind: 'tasks', scope: 'project', note: '任务与依赖账本（append-only 单写者）' },
    { kind: 'history', scope: 'project', note: '归档 / token 计量 / 成员记忆' },
    { kind: 'state', scope: 'project', note: '索引 / scratch / 日志（可重建）' },
    { kind: 'export', scope: 'project', note: '导出快照' },
    { kind: 'members', scope: 'project', note: '成员实例（身份快照 + 私有空间）' },
  ]
}
