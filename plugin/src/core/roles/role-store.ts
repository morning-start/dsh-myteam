/**
 * D4 角色库域（T5）：三来源解析 + 引用即复制 + C7 守门 + 队长校验。
 *
 * 来源三层（CHG-5/6）：
 *   builtin —— 插件包内只读（builtin-roles.ts），运行时不可变；
 *   global  —— $DSH_HOME/myteam/roles/（M1 只读展示为复制源；增删改查/发布交互 M2，CHG-16 第三刀）；
 *   project —— .team-workplace/config/roles/ = 运行时唯一真相。
 *
 * 硬规则：
 *   - 运行时只解析项目库（场景 13：删全局同名角色不影响运行中团队）；
 *   - 引用即复制、单向流动、绝不自动同步；
 *   - fork 内置 → origin: builtin:<id>（场景 14）；
 *   - C7 守门：删除被预设绑定的角色拒绝并列占用方；
 *   - FR-10.1：预设名册必含且仅含一个队长。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { BUILTIN_ROLES, type RoleDefinition, type RoleOrigin, builtinRole } from './builtin-roles.ts'

/**
 * CHG-86（tsc 真 bug）：`RoleDefinition` / `RoleOrigin` 是本模块对外数据类型的一部分
 * （`RoleEntry.definition` / `RoleEntry.origin`），但此前只是**本地 import**、没有 re-export，
 * 于是 `remote/views.ts` 从 `role-store.ts` 导入这两个类型直接 TS2459。
 * 在这里显式转出，保持「角色域的类型都从 role-store 取」这个既有口径。
 */
export type { RoleDefinition, RoleOrigin } from './builtin-roles.ts'

/** CHG-98（审计 A7）：错误码走单一来源 `core/errors.ts`，拼错在编译期就被拦住。 */
import type { MtCode } from '../errors.ts'

export class RoleError extends Error {
  code: MtCode
  detail?: unknown
  constructor(code: MtCode, message: string, detail?: unknown) {
    super(message)
    this.name = 'RoleError'
    this.code = code
    this.detail = detail
  }
}

export interface RoleEntry {
  origin: RoleOrigin
  definition: RoleDefinition
  /** 项目库文件路径（project 来源时）；builtin/global/plugin 来源为空 */
  filePath?: string
  /**
   * CHG-74：同名副本的优先级裁决——被更高优先级来源压过时标注「谁让我让位」。
   * 同名副本是常态（spawn 会把内置角色复制进项目库；全局角色也可复制成项目副本），
   * 但**运行时只认项目库**（R13），所以同名时项目库那份是真相，其余让位并留痕。
   */
  shadowedBy?: RoleOrigin
  /**
   * CHG-91：`plugin` 来源的插件 id（面板显示「由插件 <displayName> 提供」用）。
   * 其它来源为空——内置角色没有插件归属。
   */
  pluginId?: string
}

/**
 * CHG-74 来源优先级（数字大者优先；项目库 = 运行时真相）。
 *
 * CHG-91 插入 `plugin: 1`（原 `global: 1 / project-role: 2 / project: 3` 整体 +1）：
 * 插件贡献的是**默认能力**，用户一旦在全局库/项目库写了同 id，**用户那份赢**。
 * 这条顺序是契约 §7.1 的可执行形式，改动必须同步 `docs/16` 与面板 `role.origin.*` 词条。
 */
export const ROLE_ORIGIN_PRECEDENCE: Record<RoleOrigin, number> = {
  builtin: 0,
  plugin: 1,
  global: 2,
  'project-role': 3,
  project: 4,
}

export interface RoleStorePaths {
  projectRolesDir: string
  globalRolesDir?: string
  /** 项目自身角色（CHG-69，FR-19）：config/project-role.json，schema 同角色；缺省由 projectRolesDir 推导 */
  projectRoleFile?: string
}

/* ── 项目库读写（运行时唯一真相） ────────────────────────────── */

function projectRolePath(dir: string, id: string): string {
  return join(dir, `${id}.json`)
}

/** 项目自身角色文件（不属于任何团队，可被本项目各团队聘任；FR-19） */
export function projectRoleFilePath(paths: RoleStorePaths): string {
  return paths.projectRoleFile ?? join(paths.projectRolesDir, '..', 'project-role.json')
}

/** 读项目自身角色（文件缺失/损坏 → undefined；损坏不抛，面板降级为「未设置」） */
export function readProjectRoleCard(paths: RoleStorePaths): RoleDefinition | undefined {
  const p = projectRoleFilePath(paths)
  if (!existsSync(p)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as RoleDefinition
    if (typeof parsed?.id !== 'string' || typeof parsed?.systemPrompt !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** 写项目自身角色（schema 校验同普通角色；单文件，覆盖语义） */
export function writeProjectRoleCard(paths: RoleStorePaths, def: RoleDefinition): { filePath: string } {
  assertValidRole(def)
  const p = projectRoleFilePath(paths)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify(def, null, 2)}\n`, 'utf8')
  return { filePath: p }
}

/** 取消项目自身角色（文件删除；幂等） */
export function clearProjectRoleCard(paths: RoleStorePaths): void {
  const p = projectRoleFilePath(paths)
  if (existsSync(p)) unlinkSync(p)
}

export function readProjectRole(dir: string, id: string): RoleDefinition | undefined {
  const p = projectRolePath(dir, id)
  if (!existsSync(p)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as RoleDefinition
    if (typeof parsed.id !== 'string' || typeof parsed.systemPrompt !== 'string') {
      throw new RoleError('MT_ROLE_CORRUPT', `project role file ${p} is not a valid role definition`)
    }
    return parsed
  } catch (e) {
    if (e instanceof RoleError) throw e
    throw new RoleError('MT_ROLE_CORRUPT', `project role file ${p} failed to parse`, e)
  }
}

/**
 * 列出目录下的角色定义。
 *
 * **坏文件 fail loud（T5 定案，别改成静默跳过）**：`config/roles/` 是配置资产目录，
 * 里面的 `.json` **必须**是合法角色定义；读到坏文件抛 `MT_ROLE_CORRUPT` 而不是悄悄跳过——
 * 静默跳过会让「角色丢了」看起来像「从没建过」，用户永远不知道该修哪个文件。
 *
 * CHG-87 教训：正因为这条纪律，**非角色配置不能放进 `config/roles/`**
 * （`session-defaults.json` 早期放在这里，直接把整个角色目录读崩）。
 * 会话默认值已挪到 `config/session-defaults.json`。
 */
export function listProjectRoles(dir: string): RoleDefinition[] {
  if (!existsSync(dir)) return []
  const out: RoleDefinition[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const def = readProjectRole(dir, name.slice(0, -5))
    if (def) out.push(def)
  }
  return out
}

/** 写入项目角色（含 schema 最小校验；C5 只能收窄在解析时校验 toolPolicy） */
export function writeProjectRole(dir: string, def: RoleDefinition): { filePath: string } {
  assertValidRole(def)
  mkdirSync(dir, { recursive: true })
  const p = projectRolePath(dir, def.id)
  writeFileSync(p, `${JSON.stringify(def, null, 2)}\n`, 'utf8')
  return { filePath: p }
}

/** C7 守门：删除角色（project 来源）；bindings = 占用方列表（预设 id / 团队 id） */
export function deleteProjectRole(dir: string, id: string, bindings: string[]): void {
  if (bindings.length > 0) {
    throw new RoleError('MT_ROLE_OCCUPIED', `role "${id}" is bound by: ${bindings.join(', ')}`, bindings)
  }
  const p = projectRolePath(dir, id)
  if (!existsSync(p)) throw new RoleError('MT_ROLE_NOT_FOUND', `role "${id}" not found in project library`)
  unlinkSync(p)
}

/* ── 面板写入口（CHG-72，ADR-006 R1）：角色是配置资产，不进账本 ──────────
 * 与工具管线共享同一份 assertValidRole；覆盖既有文件必须显式 overwrite（两段确认），
 * 并在config/roles/.audit.jsonl 留一行旁路审计（谁在什么时候改了哪个角色文件）。 */

/** 角色库审计行（配置资产不进账本；.audit.jsonl 不会被 listProjectRoles 当成角色读） */
export interface RoleAuditEntry {
  action: 'created' | 'updated' | 'deleted'
  roleId: string
  file: string
  actor?: string
}

export function roleAuditPath(paths: RoleStorePaths): string {
  return join(paths.projectRolesDir, '.audit.jsonl')
}

export function appendRoleAudit(paths: RoleStorePaths, entry: RoleAuditEntry): string {
  const p = roleAuditPath(paths)
  mkdirSync(dirname(p), { recursive: true })
  appendFileSync(p, `${JSON.stringify({ ts: Date.now(), actor: entry.actor ?? 'human', action: entry.action, roleId: entry.roleId, file: entry.file })}\n`, 'utf8')
  return p
}

/**
 * 面板保存项目角色：新建 or 显式覆盖。
 * - captain 是内置身份，禁止用项目角色覆盖（否则名册「有且仅有一个队长」失效）；
 * - 同名已存在且 overwrite !== true → MT_ROLE_EXISTS（不静默覆盖，两段确认在调用方）；
 * - 校验与工具链同源（assertValidRole）。
 */
export function saveProjectRole(
  paths: RoleStorePaths,
  def: RoleDefinition,
  opts: { overwrite?: boolean; actor?: string } = {},
): { filePath: string; action: 'created' | 'updated'; auditPath: string } {
  if (def?.id === 'captain') {
    throw new RoleError('MT_ROLE_INVALID', 'captain is a builtin identity; create a project role with a different id')
  }
  assertValidRole(def)
  const existing = readProjectRole(paths.projectRolesDir, def.id)
  if (existing && opts.overwrite !== true) {
    throw new RoleError('MT_ROLE_EXISTS', `project role "${def.id}" already exists; pass overwrite to replace it`, { id: def.id, version: existing.version ?? 1 })
  }
  const { filePath } = writeProjectRole(paths.projectRolesDir, def)
  const auditPath = appendRoleAudit(paths, { action: existing ? 'updated' : 'created', roleId: def.id, file: filePath, actor: opts.actor })
  return { filePath, action: existing ? 'updated' : 'created', auditPath }
}

/**
 * CHG-73（FR-27）：删除项目角色 —— 配置资产的第三种写操作（新建/更新/删除）。
 * 纪律与保存同源：
 *  - 只能删项目库（内置/全局是复制源，删了会误导"改了全局"）；
 *  - captain 身份不可删（名册「有且仅有一个队长」靠它）；
 *  - 被占用（模板引用 / 团队在册）拒绝并列占用方（C7 守门，拒绝式）；
 *  - 删除也留审计行（.audit.jsonl，action=deleted）。
 */
export function deleteProjectRoleSafe(
  paths: RoleStorePaths,
  roleId: string,
  opts: { bindings?: string[]; actor?: string } = {},
): { filePath: string; auditPath: string } {
  if (roleId === 'captain') {
    throw new RoleError('MT_ROLE_CAPTAIN', 'captain is a builtin identity; it cannot be deleted')
  }
  const bindings = (opts.bindings ?? []).filter((binding) => binding.length > 0)
  if (bindings.length > 0) {
    throw new RoleError('MT_ROLE_OCCUPIED', `role "${roleId}" is still bound by: ${bindings.join(', ')}`, bindings)
  }
  const p = projectRolePath(paths.projectRolesDir, roleId)
  if (!existsSync(p)) {
    // 项目库没有：内置/全局角色只读，明确拒绝而不是"删成功了但什么都没变"
    if (builtinRole(roleId) || (paths.globalRolesDir && existsSync(join(paths.globalRolesDir, `${roleId}.json`)))) {
      throw new RoleError('MT_ROLE_BUILTIN', `role "${roleId}" comes from a read-only library (builtin/global); copy it into the project to edit/delete`)
    }
    throw new RoleError('MT_ROLE_NOT_FOUND', `role "${roleId}" not found in project library`)
  }
  unlinkSync(p)
  const auditPath = appendRoleAudit(paths, { action: 'deleted', roleId, file: p, actor: opts.actor })
  return { filePath: p, auditPath }
}

/* ── 解析与复制（引用即复制） ───────────────────────────────── */
/** 运行时解析：只认项目库，未命中回 undefined（绝不静默回退到内置/全局——防止"改全局不生效"误解，R13） */
export function resolveRuntimeRole(paths: RoleStorePaths, id: string): RoleEntry | undefined {
  const def = readProjectRole(paths.projectRolesDir, id)
  if (def) return { origin: 'project', definition: def, filePath: projectRolePath(paths.projectRolesDir, id) }
  return undefined
}

/**
 * CHG-74：目录视图（面板/选择器展示用）：builtin + global + project + 项目自身角色并列，标 origin（B7 三态）。
 *
 * **同名副本口径**：同一个 id 可能同时存在多份（内置只读 / 全局个人资产 / 项目库副本 / 项目自身角色）。
 * 目录**不隐藏**任何一份（隐藏会让人以为自己的角色丢了），而是按来源优先级裁决出「生效的那份」，
 * 其余标注 `shadowedBy`（谁让我让位）——运行时真相恒为项目库（R13）。
 *
 * @param contributions CHG-91：插件贡献的角色（已由 `parseContributions` 盖 `origin: 'plugin:<id>'`）。
 *   缺省 = 没有插件贡献。**优先级在 builtin 与 global 之间**（契约 §7.1）。
 */
export function listRoleCatalog(paths: RoleStorePaths, contributions?: readonly RoleDefinition[]): RoleEntry[] {
  const out: RoleEntry[] = []
  for (const def of BUILTIN_ROLES) out.push({ origin: 'builtin', definition: def })
  for (const def of contributions ?? []) {
    // 插件贡献的定义里 `origin` 存的是 `plugin:<pluginId>`（盖章），条目 origin 是 `plugin`
    const pluginId = String(def.origin ?? '').replace(/^plugin:/, '') || undefined
    out.push({ origin: 'plugin', definition: def, ...(pluginId ? { pluginId } : {}) })
  }
  if (paths.globalRolesDir && existsSync(paths.globalRolesDir)) {
    for (const def of listProjectRoles(paths.globalRolesDir)) out.push({ origin: 'global', definition: def })
  }
  for (const def of listProjectRoles(paths.projectRolesDir)) out.push({ origin: 'project', definition: def, filePath: projectRolePath(paths.projectRolesDir, def.id) })
  // 项目自身角色（CHG-69）：它是「项目这个实体的角色」，与库内同 id 的条目并存（CHG-74：不再顶掉，只做裁决标注）
  const projectRole = readProjectRoleCard(paths)
  if (projectRole) {
    out.push({ origin: 'project-role', definition: projectRole, filePath: projectRoleFilePath(paths) })
  }
  return markShadowedRoles(out)
}

/**
 * CHG-74：同名副本裁决——每个 id 只保留一份「生效条目」，其余标 `shadowedBy`。
 * 优先级：project > project-role > global > plugin > builtin（项目库 = 运行时真相，用户压得过插件）。
 */
export function markShadowedRoles(entries: RoleEntry[]): RoleEntry[] {
  const byId = new Map<string, RoleEntry[]>()
  for (const entry of entries) {
    const list = byId.get(entry.definition.id) ?? []
    list.push(entry)
    byId.set(entry.definition.id, list)
  }
  for (const list of byId.values()) {
    if (list.length < 2) continue
    const winner = list.reduce((best, entry) => (ROLE_ORIGIN_PRECEDENCE[entry.origin] > ROLE_ORIGIN_PRECEDENCE[best.origin] ? entry : best))
    for (const entry of list) {
      if (entry !== winner) entry.shadowedBy = winner.origin
    }
  }
  return entries
}

/**
 * CHG-74：某个 id 的**生效条目**（同名副本里优先级最高的那份）。
 * 详情页/编辑入口必须用它——否则会出现「项目里改的那份，详情却显示内置定义」的错觉。
 */
export function resolveEffectiveRole(entries: RoleEntry[], roleId: string): RoleEntry | undefined {
  const candidates = entries.filter((entry) => entry.definition.id === roleId)
  if (candidates.length === 0) return undefined
  return candidates.reduce((best, entry) => (ROLE_ORIGIN_PRECEDENCE[entry.origin] > ROLE_ORIGIN_PRECEDENCE[best.origin] ? entry : best))
}

/**
 * 引用即复制：从任意来源复制为项目角色；同名已存在 → 拒绝（单向、不覆盖）
 *
 * CHG-91：`source === 'plugin'` 时从 `contributions` 里找定义（插件贡献物不在任何可写目录里，
 * 只能从装载结果取）。复制后 `origin` 保留 `plugin:<pluginId>` 溯源，用户改的是项目库那份。
 */
export function copyToProject(
  paths: RoleStorePaths,
  id: string,
  source: RoleOrigin,
  contributions?: readonly RoleDefinition[],
): { filePath: string } {
  let def: RoleDefinition | undefined
  if (source === 'builtin') def = builtinRole(id)
  else if (source === 'plugin') {
    def = contributions?.find((role) => role.id === id)
    if (!def) throw new RoleError('MT_ROLE_NOT_FOUND', `role "${id}" not found in plugin contributions`)
  } else if (source === 'global') {
    if (!paths.globalRolesDir) throw new RoleError('MT_ROLE_NO_GLOBAL_DIR', 'global roles dir not configured')
    def = readProjectRole(paths.globalRolesDir, id)
  } else if (source === 'project-role') {
    def = readProjectRoleCard(paths)
  } else {
    def = readProjectRole(paths.projectRolesDir, id)
  }
  if (!def) throw new RoleError('MT_ROLE_NOT_FOUND', `role "${id}" not found in ${source} library`)
  if (readProjectRole(paths.projectRolesDir, id)) {
    throw new RoleError('MT_ROLE_EXISTS', `project role "${id}" already exists; copy refused (no silent overwrite)`)
  }
  // fork 内置 → origin 标记；升级不追溯（CHG-6）。插件来源保留自己的 `plugin:<id>` 溯源。
  const copy: RoleDefinition =
    source === 'builtin'
      ? { ...structuredClone(def), origin: `builtin:${id}` }
      : structuredClone(def)
  return writeProjectRole(paths.projectRolesDir, copy)
}

/* ── 校验 ───────────────────────────────────────────────────── */

/**
 * `toolPolicy.allow` 允许的条目形状。
 *
 * CHG-91（修 CHG-58 遗留的真 bug）：原模式是 `^[a-z][a-z0-9_]*$`——**只认小写**，
 * 于是 `allow: ["Read"]` 被判非法。但宿主原生工具名就是 PascalCase
 * （`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob`），`buildToolMask` 又是
 * **原样**传给 `restrict({allow})` 的——即「合法名字写不进去，写进去的都是查不到的小写名」。
 *
 * 现在的口径（宽松但仍可判定）：
 *  - `myteam_*` 通配（团队工具面）；
 *  - 任意 `[A-Za-z][A-Za-z0-9_]*`（覆盖 PascalCase 原生工具、snake_case 成员工具、`mcp__server__tool`）。
 * **仍然拒绝**：空串、含空格/分号/点/斜杠的注入尝试（`'Bash; rm'` 这类）。
 */
const TOOL_ALLOW_PATTERNS = [/^myteam_\*$/, /^[A-Za-z][A-Za-z0-9_]*$/]

export function assertValidRole(def: RoleDefinition): void {
  if (typeof def.id !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(def.id)) {
    throw new RoleError('MT_ROLE_INVALID', `role id "${def.id}" invalid (lowercase alnum + dash)`)
  }
  if (typeof def.systemPrompt !== 'string' || def.systemPrompt.trim().length === 0) {
    throw new RoleError('MT_ROLE_INVALID', `role "${def.id}" requires non-empty systemPrompt`)
  }
  // C5：toolPolicy 只能收窄——allow 项必须是合法工具名或 myteam_* 前缀通配
  if (def.toolPolicy?.allow) {
    for (const a of def.toolPolicy.allow) {
      if (!TOOL_ALLOW_PATTERNS.some((re) => re.test(a))) {
        throw new RoleError('MT_ROLE_INVALID', `role "${def.id}" toolPolicy.allow entry "${a}" is not a valid tool name`)
      }
    }
  }
  // 兴趣词（CHG-69）：只能是「描述关注面」的短词，≤8 个、每个 1~16 字；不参与权限判定
  if (def.interestWords !== undefined) {
    if (!Array.isArray(def.interestWords) || def.interestWords.length > 8) {
      throw new RoleError('MT_ROLE_INVALID', `role "${def.id}" interestWords must be an array of at most 8 items`)
    }
    for (const word of def.interestWords) {
      if (typeof word !== 'string' || word.trim().length === 0 || word.trim().length > 16) {
        throw new RoleError('MT_ROLE_INVALID', `role "${def.id}" interestWords entries must be non-empty strings (1~16 chars)`)
      }
    }
  }
  // 队长是**类**，全局唯一：只有 id === 'captain' 能带 isCaptain 标记。
  //
  // 为什么在这里拦（CHG-101）：`validateRoster` 是**按名册**判的（一个名册里恰好
  // 一个队长），它管不到「不同团队各用一个不同的队长类」——那样「队长的设定」
  // 就变成复数了，而模型要求它是单数（类全局唯一 / 实例每团队一个）。
  //
  // 想改队长的提示词或工具集？项目库覆写 `config/roles/captain.json` 即可 ——
  // 换的是**同一份设定的实现**，不是新增第二个队长类。
  //
  // 注意这**不能**取代 `validateRoster`：手写 JSON（绕过 writeProjectRole 的
  // assertValidRole）仍可能造出两个 isCaptain 定义，名册校验是那道兜底。
  if (def.isCaptain === true && def.id !== 'captain') {
    throw new RoleError(
      'MT_ROLE_CAPTAIN_RESERVED',
      `role "${def.id}" cannot declare isCaptain:true — captain is a builtin identity; ` +
        'override the "captain" role in the project library instead of creating a second captain identity',
    )
  }
}

/** FR-10.1：名册必含且仅含一个队长（保存预设/创建团队时校验） */
export function validateRoster(roster: { roleId: string }[], paths: RoleStorePaths): void {
  if (roster.length === 0) throw new RoleError('MT_ROSTER_EMPTY', 'roster is empty')
  const captainEntries = roster.filter((m) => {
    // 队长判定：项目库优先，回内置定义（草稿阶段角色可能尚未复制进项目）
    const def = readProjectRole(paths.projectRolesDir, m.roleId) ?? builtinRole(m.roleId)
    return def?.isCaptain === true
  })
  if (captainEntries.length === 0) {
    throw new RoleError('MT_ROSTER_NO_CAPTAIN', 'roster must include exactly one captain role (none found)')
  }
  if (captainEntries.length > 1) {
    throw new RoleError('MT_ROSTER_DUAL_CAPTAIN', `roster must include exactly one captain role (found ${captainEntries.length})`)
  }
}
