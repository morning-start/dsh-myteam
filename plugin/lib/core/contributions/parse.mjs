/**
 * CHG-91（契约 §8.2）：贡献目录的**解析 + 校验 + 冲突裁决**。
 *
 * 本模块是**纯函数**：只 `readFileSync` / `JSON.parse`，不写盘、不碰账本、不 `import()` 插件代码
 * （契约 P2「数据不是代码」）。于是「坏插件」可以穷举测试——这是整个贡献点的可验证性基础。
 *
 * 校验顺序（契约 §4.4，决定错误码）：
 *   0 去 BOM → 1 清单可解析 → 2 contractVersion → 3 pluginId 形状/相等 → 4 重复
 *   → 5 displayName/version → 6 roles → 7 teams
 *
 * **任一条目级失败只丢该条目**，不丢整个插件（1~5 是清单级失败，整插件跳过）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { assertValidRole, RoleError } from '../roles/role-store.mjs'
                                                               
                                                                  
import { discoverContributions } from './discover.mjs'
import {
  CONTRIBUTION_CODES,
  MAX_CONTRIBUTION_FILE_BYTES,
  SUPPORTED_CONTRACT_VERSIONS,
  CONTRIBUTION_CONTRACT_VERSION,
  describeContribution,
                           
                          
                           
                          
} from './contract.mjs'

/* ── 形状常量（与 docs/16 §4 §5 逐字对应）────────────────────────── */

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,63}$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const SAFE_TEMPLATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

                               
     
                                            
                                            
     
                                      
                        
                                          
     
                                                          
                                                    
     
                                         
              
 

/* ── 收集器（避免到处 push 一堆对象字面量）──────────────────────── */

function collector() {
  const warnings                        = []
  return {
    warnings,
    push(level                              , code        , pluginId        , detail                          = {}, path         ) {
      const warning                      = { level, code, message: describeContribution(code, detail), pluginId }
      if (path) warning.path = path
      if (typeof detail.conflictsWith === 'string') warning.conflictsWith = detail.conflictsWith
      warnings.push(warning)
      return warning
    },
    error(code        , pluginId        , detail                          , path         ) {
      return this.push('error', code, pluginId, detail, path)
    },
    warn(code        , pluginId        , detail                          , path         ) {
      return this.push('warn', code, pluginId, detail, path)
    },
    info(code        , pluginId        , detail                          , path         ) {
      return this.push('info', code, pluginId, detail, path)
    },
  }
}

/* ── 文件读取（**去 BOM**：契约 §4.4 第 0 步）────────────────────── */

                                                                                                             

/**
 * 读 + 解析 JSON。
 *
 * 去 BOM 不是洁癖：Windows 上 `Set-Content -Encoding UTF8`（PS 5.1）与记事本「UTF-8」
 * 都写 `EF BB BF`，而 `JSON.parse('\uFEFF{...}')` 直接抛 `Unexpected token`——
 * 插件作者会以为清单写错了（`t76-23` 锁定）。
 */
function readJsonFile(filePath        )             {
  if (!existsSync(filePath)) return { ok: false, code: CONTRIBUTION_CODES.FILE_MISSING, detail: { file: filePath } }
  let size = 0
  try {
    size = statSync(filePath).size
  } catch {
    return { ok: false, code: CONTRIBUTION_CODES.FILE_MISSING, detail: { file: filePath } }
  }
  if (size > MAX_CONTRIBUTION_FILE_BYTES) {
    return { ok: false, code: CONTRIBUTION_CODES.TOO_LARGE, detail: { file: filePath, size } }
  }
  try {
    return { ok: true, value: JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) }
  } catch (error) {
    return {
      ok: false,
      code: CONTRIBUTION_CODES.MANIFEST_INVALID,
      detail: { file: filePath, reason: (error         ).message },
    }
  }
}

/** `file` 字段必须是插件目录内的相对路径（禁 `..`、禁绝对路径、禁解析后越界） */
function resolveInsidePlugin(dir        , file         )                     {
  if (typeof file !== 'string' || file.length === 0) return undefined
  if (isAbsolute(file)) return undefined
  const normalized = normalize(file).replaceAll('\\', '/')
  if (normalized.startsWith('..')) return undefined
  const target = resolve(dir, file)
  const rel = relative(dir, target)
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) return undefined
  return target
}

function isPlainObject(value         )                                   {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value         )                  {
  return typeof value === 'string' && value.trim().length > 0
}

/* ── 单插件解析 ──────────────────────────────────────────────────── */

                             
                             
                         
                           
 

function parsePlugin(
  source                    ,
  report                              ,
  opts              ,
  seenPluginIds                     ,
  pluginRoleIds                     ,
  pluginTemplateIds                     ,
)                    {
  const { pluginId, dir, manifestPath } = source
  const dirName = pluginId

  /* 1. 清单可解析 */
  const manifestRead = readJsonFile(manifestPath)
  if (!manifestRead.ok) {
    report.error(manifestRead.code === CONTRIBUTION_CODES.FILE_MISSING ? CONTRIBUTION_CODES.MANIFEST_INVALID : manifestRead.code, pluginId, manifestRead.detail, manifestPath)
    return { roles: [], teams: [] }
  }
  const manifest = manifestRead.value
  if (!isPlainObject(manifest)) {
    report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: 'plugin.json 必须是 JSON 对象' }, manifestPath)
    return { roles: [], teams: [] }
  }

  /* 2. contractVersion（整数 + 集合成员；高版本整插件跳过） */
  const contractVersion = manifest.contractVersion
  if (typeof contractVersion !== 'number' || !Number.isInteger(contractVersion)) {
    report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: 'contractVersion 必须是整数（当前契约 = 1）' }, manifestPath)
    return { roles: [], teams: [] }
  }
  if (!SUPPORTED_CONTRACT_VERSIONS.has(contractVersion)) {
    report.error(CONTRIBUTION_CODES.CONTRACT_UNSUPPORTED, pluginId, { contractVersion }, manifestPath)
    return { roles: [], teams: [] }
  }

  /* 3. pluginId 形状 + 与目录名相等（形状先于比对，契约 §4.4） */
  if (typeof manifest.pluginId !== 'string' || !PLUGIN_ID_RE.test(manifest.pluginId)) {
    report.error(CONTRIBUTION_CODES.ID_INVALID, pluginId, { pluginId: manifest.pluginId }, manifestPath)
    return { roles: [], teams: [] }
  }
  if (manifest.pluginId !== dirName) {
    report.error(CONTRIBUTION_CODES.ID_MISMATCH, pluginId, { pluginId: manifest.pluginId, dirName }, manifestPath)
    return { roles: [], teams: [] }
  }

  /* 4. 与已装载插件重复（字典序后者失败 —— 由调用方按序调用保证） */
  if (seenPluginIds.has(pluginId)) {
    report.error(CONTRIBUTION_CODES.ID_DUPLICATE, pluginId, { pluginId }, manifestPath)
    return { roles: [], teams: [] }
  }

  /* 5. displayName / version */
  if (!nonEmptyString(manifest.displayName)) {
    report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: 'displayName 必需且非空' }, manifestPath)
    return { roles: [], teams: [] }
  }
  if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) {
    report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: `version 必须是 semver 形状（实际 ${JSON.stringify(manifest.version)}）` }, manifestPath)
    return { roles: [], teams: [] }
  }

  const namespace = nonEmptyString(manifest.namespace) ? manifest.namespace.trim() : (pluginId.split('-')[0] ?? pluginId)
  const roles                   = []
  const teams                     = []
  const localRoleIds = new Set        ()
  const localTemplateIds = new Set        ()

  /* 6. 角色 */
  if (manifest.roles !== undefined && !Array.isArray(manifest.roles)) {
    report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: 'roles 必须是数组' }, manifestPath)
  }
  for (const [index, item] of (Array.isArray(manifest.roles) ? manifest.roles : []).entries()) {
    const where = `roles[${index}]`
    if (!isPlainObject(item)) {
      report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: `${where} 必须是对象 {id, file}` }, manifestPath)
      continue
    }
    const declaredId = typeof item.id === 'string' ? item.id : ''
    const rolePath = resolveInsidePlugin(dir, item.file)
    if (rolePath === undefined) {
      report.error(CONTRIBUTION_CODES.PATH_TRAVERSAL, pluginId, { file: item.file }, manifestPath)
      continue
    }
    if (!PLUGIN_ID_RE.test(declaredId)) {
      report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: `${where}.id 不合规：${JSON.stringify(item.id)}` }, manifestPath)
      continue
    }
    const roleRead = readJsonFile(rolePath)
    if (!roleRead.ok) {
      // 角色文件缺失/坏 JSON：FILE_MISSING 原样报；坏 JSON 归 MT_ROLE_INVALID（不是清单的错）
      report.error(
        roleRead.code === CONTRIBUTION_CODES.FILE_MISSING ? CONTRIBUTION_CODES.FILE_MISSING : CONTRIBUTION_CODES.MANIFEST_INVALID,
        pluginId,
        roleRead.detail,
        rolePath,
      )
      continue
    }
    const role = roleRead.value
    if (!isPlainObject(role)) {
      report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: `${item.file} 必须是 JSON 对象` }, rolePath)
      continue
    }
    if (role.id !== declaredId) {
      report.error(CONTRIBUTION_CODES.ID_MISMATCH_ENTRY, pluginId, { file: item.file, actual: role.id, declared: declaredId }, rolePath)
      continue
    }
    /* 队长保留（名册锚点只能来自内置 captain） */
    if (role.isCaptain === true) {
      report.error(CONTRIBUTION_CODES.CAPTAIN_RESERVED, pluginId, { roleId: declaredId }, rolePath)
      continue
    }
    /* 撞 builtin = 硬失败（静默替换语义字段是最危险的 bug 类型，契约 §7.2） */
    if (opts.builtinRoleIds?.has(declaredId)) {
      report.error(CONTRIBUTION_CODES.ROLE_CONFLICT, pluginId, {
        roleId: declaredId,
        conflictsWith: 'builtin',
        suggestion: `${namespace}-${declaredId}`,
      }, rolePath)
      continue
    }
    /* 插件内重复 / 跨插件重复（两者都是硬失败） */
    if (localRoleIds.has(declaredId)) {
      report.error(CONTRIBUTION_CODES.ROLE_CONFLICT, pluginId, { roleId: declaredId, conflictsWith: pluginId, suggestion: `${namespace}-${declaredId}` }, rolePath)
      continue
    }
    if (pluginRoleIds.has(declaredId)) {
      report.error(CONTRIBUTION_CODES.ROLE_CONFLICT, pluginId, { roleId: declaredId, conflictsWith: 'other-plugin', suggestion: `${namespace}-${declaredId}` }, rolePath)
      continue
    }
    /* 角色 schema 校验（与面板保存同源，C5 只收窄） */
    try {
      assertValidRole(role                             )
    } catch (error) {
      const err = error             
      report.error(err.code ?? CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { message: err.message, reason: err.message }, rolePath)
      continue
    }
    /* origin 由 myteam 盖章；作者写了就警告（会被覆盖） */
    if (role.origin !== undefined) {
      report.warn(CONTRIBUTION_CODES.ORIGIN_STAMPED, pluginId, { roleId: declaredId, pluginId }, rolePath)
    }

    localRoleIds.add(declaredId)
    roles.push({ ...(structuredClone(role)                             ), origin: `plugin:${pluginId}` })
  }

  /* 7. 团队模板 —— 可解析集合 = 已知 ∪ 本插件已装载角色 */
  const resolvable = new Set        ([...(opts.resolvableRoleIds ?? []), ...localRoleIds, ...pluginRoleIds])
  if (manifest.teams !== undefined && !Array.isArray(manifest.teams)) {
    report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: 'teams 必须是数组' }, manifestPath)
  }
  for (const [index, item] of (Array.isArray(manifest.teams) ? manifest.teams : []).entries()) {
    const where = `teams[${index}]`
    if (!isPlainObject(item)) {
      report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: `${where} 必须是对象 {id, file}` }, manifestPath)
      continue
    }
    const declaredId = typeof item.id === 'string' ? item.id : ''
    const teamPath = resolveInsidePlugin(dir, item.file)
    if (teamPath === undefined) {
      report.error(CONTRIBUTION_CODES.PATH_TRAVERSAL, pluginId, { file: item.file }, manifestPath)
      continue
    }
    if (!SAFE_TEMPLATE_ID_RE.test(declaredId) || declaredId.includes('..')) {
      report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: `${where}.id 不合规：${JSON.stringify(item.id)}` }, manifestPath)
      continue
    }
    const teamRead = readJsonFile(teamPath)
    if (!teamRead.ok) {
      report.error(
        teamRead.code === CONTRIBUTION_CODES.FILE_MISSING ? CONTRIBUTION_CODES.FILE_MISSING : CONTRIBUTION_CODES.MANIFEST_INVALID,
        pluginId,
        teamRead.detail,
        teamPath,
      )
      continue
    }
    const team = teamRead.value
    if (!isPlainObject(team)) {
      report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: `${item.file} 必须是 JSON 对象` }, teamPath)
      continue
    }
    if (team.id !== declaredId) {
      report.error(CONTRIBUTION_CODES.ID_MISMATCH_ENTRY, pluginId, { file: item.file, actual: team.id, declared: declaredId }, teamPath)
      continue
    }
    if (opts.builtinTemplateIds?.has(declaredId)) {
      report.error(CONTRIBUTION_CODES.TEAM_CONFLICT, pluginId, { teamId: declaredId, conflictsWith: 'builtin' }, teamPath)
      continue
    }
    if (localTemplateIds.has(declaredId) || pluginTemplateIds.has(declaredId)) {
      report.error(CONTRIBUTION_CODES.TEAM_CONFLICT, pluginId, { teamId: declaredId, conflictsWith: 'other-plugin' }, teamPath)
      continue
    }
    if (!nonEmptyString(team.name)) {
      report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: `团队模板 "${declaredId}" 缺少 name` }, teamPath)
      continue
    }
    if (!Array.isArray(team.members) || team.members.length === 0) {
      report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: `团队模板 "${declaredId}" 的 members 必须是非空数组` }, teamPath)
      continue
    }
    const unresolved           = []
    let hasCaptain = false
    for (const [mIndex, member] of (team.members             ).entries()) {
      const memberObj = isPlainObject(member) ? member : {}
      const roleId = memberObj.roleId
      if (!nonEmptyString(roleId)) {
        report.error(CONTRIBUTION_CODES.MANIFEST_INVALID, pluginId, { reason: `团队模板 "${declaredId}" members[${mIndex}].roleId 缺失` }, teamPath)
        continue
      }
      if (roleId === 'captain') { hasCaptain = true; continue }
      if (!resolvable.has(roleId)) unresolved.push(roleId)
    }
    if (hasCaptain) {
      report.error(CONTRIBUTION_CODES.TEAM_CAPTAIN, pluginId, { teamId: declaredId }, teamPath)
      continue
    }
    if (unresolved.length > 0) {
      report.error(CONTRIBUTION_CODES.TEAM_UNRESOLVED, pluginId, { teamId: declaredId, roleIds: [...new Set(unresolved)] }, teamPath)
      continue
    }

    localTemplateIds.add(declaredId)
    teams.push(structuredClone(team)                               )
  }

  /* 8. 可执行文件：不执行，只 info（P2 数据不是代码） */
  try {
    const stray = readdirSync(dir).filter((name) => /\.(c|m)?js$/i.test(name))
    if (stray.length > 0) report.info(CONTRIBUTION_CODES.CODE_IGNORED, pluginId, { files: stray }, dir)
  } catch { /* 目录不可读：上层已按「插件级失败」处理 */ }

  const plugin                     = {
    pluginId,
    displayName: manifest.displayName.trim(),
    version: manifest.version,
    namespace,
    dir,
    ...(nonEmptyString(manifest.description) ? { description: manifest.description.trim() } : {}),
    ...(nonEmptyString(manifest.homepage) ? { homepage: manifest.homepage.trim() } : {}),
    ...(isPlainObject(manifest.requires) ? { requires: manifest.requires } : {}),
    roles: roles.map((role) => role.id),
    teams: teams.map((team) => team.id),
    // 条目级失败不影响「插件可用」——只有清单级失败才 invalid（见上面的 early return）
    status: 'ok',
  }
  return { plugin, roles, teams }
}

/* ── 批量解析（对外主入口）───────────────────────────────────────── */

/**
 * 解析一批贡献目录。
 *
 * 纪律（契约 P4 失败隔离）：**一个插件坏了不影响其它插件**——循环里没有任何 `throw`，
 * 所有失败都变成 `warnings[]` 条目。这是「装了两个插件，一个写错了，另一个还能用」的保证。
 */
export function parseContributions(sources                      , opts               = {})                      {
  const report = collector()
  const plugins                       = []
  const roles                   = []
  const teams                     = []
  const seenPluginIds = new Set        ()
  /* 跨插件累积（冲突裁决 + 模板解析都要） */
  const pluginRoleIds = new Set        ()
  const pluginTemplateIds = new Set        ()

  for (const source of sources) {
    const result = parsePlugin(source, report, opts, seenPluginIds, pluginRoleIds, pluginTemplateIds)
    if (!result.plugin) continue
    seenPluginIds.add(result.plugin.pluginId)
    for (const role of result.roles) pluginRoleIds.add(role.id)
    for (const team of result.teams) pluginTemplateIds.add(team.id)
    plugins.push(result.plugin)
    roles.push(...result.roles)
    teams.push(...result.teams)
  }

  return {
    root: sources[0] ? resolve(sources[0].dir, '..') : '',
    plugins,
    roles,
    teams,
    warnings: report.warnings,
    scannedAt: opts.now ?? new Date().toISOString(),
    // 只有 error 级别才让 ok=false；warn/info 不阻断装载（但面板仍要显示）
    ok: report.warnings.every((warning) => warning.level !== 'error'),
  }
}

/** 便捷入口：发现 + 解析一步到位（host 装载用） */
export function loadContributions(root        , opts               = {})                      {
  const catalog = parseContributions(discoverContributions(root), opts)
  // `parseContributions` 从 sources[0] 推 root；空目录时它是 ''，这里补上调用方给的真实根
  return catalog.root === '' ? { ...catalog, root } : catalog
}


//# sourceURL=file:///E:/Workplace/extension/dsh-myteam/plugin/src/core/contributions/parse.ts