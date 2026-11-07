#!/usr/bin/env node
/**
 * myteam 插件团队贡献 —— 契约校验器（contractVersion = 1）
 *
 * 权威：仓库内 `docs/16-插件团队贡献契约.md`。本文件的每个错误码都直接对应契约 §9。
 * 目的：让插件作者在**自己的仓库里**就能验证贡献目录，而不是装进 DSH 之后才发现角色被静默跳过。
 *
 * 用法：
 *   node check-contribution.mjs <贡献目录> [--json] [--root]
 *
 *   <贡献目录>  含 plugin.json 的目录（契约 §3.2 的 <pluginId> 目录）
 *   --json      机器可读输出（CI 用）
 *   --root      传的是 plugins 根目录（含多个插件子目录），逐个校验
 *
 * 退出码：0 = 全部通过（可含 warning）；1 = 有 error（插件/条目会被跳过）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

/* ── 契约常量（改这里 = 改契约，必须同步 docs/16）────────────────── */

const SUPPORTED_CONTRACT_VERSIONS = new Set([1])
const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,63}$/
const ROLE_ID_RE = /^[a-z][a-z0-9-]{2,63}$/
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const MAX_FILE_BYTES = 256 * 1024

/** 内置角色 / 模板 id（撞上 = 硬失败，契约 §7.2） */
const BUILTIN_ROLE_IDS = new Set([
  'captain', 'implementer', 'req-validator', 'developer', 'acceptor',
  'reviewer', 'tester', 'architect', 'researcher', 'writer', 'operator',
])
const BUILTIN_TEMPLATE_IDS = new Set(['starter-team', 'triad'])

/* ── 结果收集 ─────────────────────────────────────────────────────── */

/**
 * @typedef {{ level: 'error'|'warn'|'info', code: string, message: string, path?: string, pluginId?: string, conflictsWith?: string }} Finding
 */

function createReport() {
  /** @type {Finding[]} */
  const findings = []
  const report = {
    findings,
    add(level, code, message, extra = {}) {
      findings.push({ level, code, message, ...extra })
      return report
    },
    error(code, message, extra) { return report.add('error', code, message, extra) },
    warn(code, message, extra) { return report.add('warn', code, message, extra) },
    info(code, message, extra) { return report.add('info', code, message, extra) },
    get errors() { return findings.filter((f) => f.level === 'error') },
    get warnings() { return findings.filter((f) => f.level === 'warn') },
    get ok() { return report.errors.length === 0 },
  }
  return report
}

/* ── 工具 ─────────────────────────────────────────────────────────── */

/**
 * 读 JSON 文件。
 *
 * **必须去 BOM**：Windows 上 PowerShell `Set-Content -Encoding UTF8`、记事本「UTF-8」等
 * 都会写 `EF BB BF`，而 `JSON.parse('\uFEFF{...}')` 直接抛「Unexpected token」——
 * 这个坑插件作者 100% 会踩（本校验器最初就是被自己的 BOM 测试文件打中的）。
 * 契约 §4.4 第 0 步：BOM 不构成「清单非法」。
 */
function readJson(filePath, report, code) {
  if (!existsSync(filePath)) {
    report.error(code ?? 'MT_CONTRIBUTION_FILE_MISSING', `文件不存在：${filePath}`, { path: filePath })
    return undefined
  }
  const size = statSync(filePath).size
  if (size > MAX_FILE_BYTES) {
    report.error('MT_CONTRIBUTION_TOO_LARGE', `${filePath} 超过 256 KiB（实际 ${size} B）`, { path: filePath })
    return undefined
  }
  try {
    const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch (e) {
    report.error(code ?? 'MT_PLUGIN_MANIFEST_INVALID', `${filePath} 不是合法 JSON：${e.message}`, { path: filePath })
    return undefined
  }
}

function isSafeRelativeFile(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (isAbsolute(value)) return false
  const normalized = normalize(value).replaceAll('\\', '/')
  if (normalized.startsWith('..')) return false
  return true
}

function resolveInside(dir, rel) {
  const target = resolve(dir, rel)
  const relPath = relative(dir, target)
  if (relPath === '' || relPath.startsWith('..') || relPath.includes(`..${sep}`)) return undefined
  return target
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/* ── 单个插件的校验 ───────────────────────────────────────────────── */

/**
 * 校验一个插件贡献目录。
 * @param {string} dir 含 plugin.json 的目录
 * @param {{ knownRoleIds?: Set<string>, otherPluginIds?: Set<string> }} [opts]
 * @returns {{ plugin: object|undefined, roles: object[], teams: object[], report: ReturnType<typeof createReport> }}
 */
export function checkContribution(dir, opts = {}) {
  const report = createReport()
  const dirName = dir.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  const manifestPath = join(dir, 'plugin.json')

  /* 1. 清单可读 + 可解析 */
  const manifest = readJson(manifestPath, report, 'MT_PLUGIN_MANIFEST_INVALID')
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { plugin: undefined, roles: [], teams: [], report }
  }

  /* 2. contractVersion */
  const contractVersion = manifest.contractVersion
  if (!Number.isInteger(contractVersion)) {
    report.error('MT_PLUGIN_MANIFEST_INVALID', 'contractVersion 必须是整数（当前契约 = 1）', { path: manifestPath })
    return { plugin: undefined, roles: [], teams: [], report }
  }
  if (!SUPPORTED_CONTRACT_VERSIONS.has(contractVersion)) {
    report.error(
      'MT_PLUGIN_CONTRACT_UNSUPPORTED',
      `插件要求契约 v${contractVersion}，当前 myteam 支持 v${[...SUPPORTED_CONTRACT_VERSIONS].join('/')}；该插件会被整体跳过`,
      { path: manifestPath },
    )
    return { plugin: undefined, roles: [], teams: [], report }
  }

  /* 3. pluginId：形状 + 与目录名相等 */
  const pluginId = manifest.pluginId
  if (typeof pluginId !== 'string' || !PLUGIN_ID_RE.test(pluginId)) {
    report.error('MT_PLUGIN_ID_INVALID', `pluginId 不合规：${JSON.stringify(pluginId)}（需 ^[a-z][a-z0-9-]{1,63}$）`, { path: manifestPath })
    return { plugin: undefined, roles: [], teams: [], report }
  }
  if (pluginId !== dirName) {
    report.error('MT_PLUGIN_ID_MISMATCH', `清单 pluginId="${pluginId}" 与目录名 "${dirName}" 不一致`, { path: manifestPath })
    return { plugin: undefined, roles: [], teams: [], report }
  }

  /* 4. 与其它插件重复（由调用方传入已知集） */
  if (opts.otherPluginIds?.has(pluginId)) {
    report.error('MT_PLUGIN_ID_DUPLICATE', `pluginId "${pluginId}" 与另一个插件目录重复（按目录名字典序，后者失败）`, { path: manifestPath })
    return { plugin: undefined, roles: [], teams: [], report }
  }

  /* 5. displayName / version */
  if (!isNonEmptyString(manifest.displayName)) {
    report.error('MT_PLUGIN_MANIFEST_INVALID', 'displayName 必需且非空', { path: manifestPath })
    return { plugin: undefined, roles: [], teams: [], report }
  }
  if (!isNonEmptyString(manifest.version) || !SEMVER_RE.test(manifest.version)) {
    report.error('MT_PLUGIN_MANIFEST_INVALID', `version 必须是 semver 形状（实际 ${JSON.stringify(manifest.version)}）`, { path: manifestPath })
    return { plugin: undefined, roles: [], teams: [], report }
  }

  const namespace = isNonEmptyString(manifest.namespace) ? manifest.namespace : pluginId.split('-')[0]

  /* 6. 角色 */
  const roles = []
  const roleIds = new Set()
  const roleList = Array.isArray(manifest.roles) ? manifest.roles : []
  if (manifest.roles !== undefined && !Array.isArray(manifest.roles)) {
    report.error('MT_PLUGIN_MANIFEST_INVALID', 'roles 必须是数组', { path: manifestPath })
  }
  for (const [index, item] of roleList.entries()) {
    const where = `roles[${index}]`
    if (!item || typeof item !== 'object') {
      report.error('MT_PLUGIN_MANIFEST_INVALID', `${where} 必须是对象 {id, file}`, { path: manifestPath })
      continue
    }
    const declaredId = typeof item.id === 'string' ? item.id : ''
    if (!ROLE_ID_RE.test(declaredId)) {
      report.error('MT_PLUGIN_MANIFEST_INVALID', `${where}.id 不合规：${JSON.stringify(item.id)}（需 ^[a-z][a-z0-9-]{2,63}$）`, { path: manifestPath })
      continue
    }
    if (!isSafeRelativeFile(item.file)) {
      report.error('MT_CONTRIBUTION_PATH_TRAVERSAL', `${where}.file 必须是插件目录内的相对路径：${JSON.stringify(item.file)}`, { path: manifestPath })
      continue
    }
    const rolePath = resolveInside(dir, item.file)
    if (!rolePath) {
      report.error('MT_CONTRIBUTION_PATH_TRAVERSAL', `${where}.file 解析后越出插件目录：${item.file}`, { path: manifestPath })
      continue
    }
    const role = readJson(rolePath, report, 'MT_CONTRIBUTION_FILE_MISSING')
    if (!role) continue

    /* 文件内 id 必须与清单一致 */
    if (role.id !== declaredId) {
      report.error('MT_CONTRIBUTION_ID_MISMATCH', `${item.file} 内 id="${role.id}" 与清单声明 "${declaredId}" 不一致`, { path: rolePath })
      continue
    }
    /* 队长保留 */
    if (role.isCaptain === true) {
      report.error('MT_ROLE_CAPTAIN_RESERVED', `角色 "${declaredId}" 声明了 isCaptain:true——插件不能贡献队长（队长是名册锚点）`, { path: rolePath })
      continue
    }
    /* 撞 builtin = 硬失败 */
    if (BUILTIN_ROLE_IDS.has(declaredId)) {
      report.error(
        'MT_ROLE_CONTRIBUTION_CONFLICT',
        `角色 "${declaredId}" 与内置角色冲突；请改用带前缀的 id（如 "${namespace}-${declaredId}"）`,
        { path: rolePath, conflictsWith: 'builtin' },
      )
      continue
    }
    /* 插件内重复 */
    if (roleIds.has(declaredId)) {
      report.error('MT_ROLE_CONTRIBUTION_CONFLICT', `角色 "${declaredId}" 在同一插件内重复声明`, { path: rolePath, conflictsWith: pluginId })
      continue
    }
    /* 跨插件重复（调用方已知集） */
    if (opts.knownRoleIds?.has(declaredId)) {
      report.error('MT_ROLE_CONTRIBUTION_CONFLICT', `角色 "${declaredId}" 与其它插件冲突`, { path: rolePath, conflictsWith: 'other-plugin' })
      continue
    }

    /* systemPrompt 必需 */
    if (!isNonEmptyString(role.systemPrompt)) {
      report.error('MT_ROLE_INVALID', `角色 "${declaredId}" 的 systemPrompt 必需且非空`, { path: rolePath })
      continue
    }
    /* origin 由 myteam 盖章；作者写了就警告（会被覆盖） */
    if (role.origin !== undefined) {
      report.warn('MT_CONTRIBUTION_ORIGIN_STAMPED', `角色 "${declaredId}" 的 origin 字段会被 myteam 覆盖为 "plugin:${pluginId}"，请删除该字段`, { path: rolePath })
    }
    /* 未知工具名：只警告（不扩权）—— 真正的白名单由宿主工具表裁决 */
    for (const key of ['allow', 'deny']) {
      const list = role.toolPolicy?.[key]
      if (list === undefined) continue
      if (!Array.isArray(list)) {
        report.error('MT_ROLE_INVALID', `角色 "${declaredId}" 的 toolPolicy.${key} 必须是字符串数组`, { path: rolePath })
      } else if (list.some((name) => typeof name !== 'string' || name.length === 0)) {
        report.error('MT_ROLE_INVALID', `角色 "${declaredId}" 的 toolPolicy.${key} 含非法条目`, { path: rolePath })
      }
    }

    roleIds.add(declaredId)
    roles.push({ id: declaredId, definition: role, filePath: rolePath })
  }

  /* 7. 团队模板 */
  const teams = []
  const teamIds = new Set()
  const teamList = Array.isArray(manifest.teams) ? manifest.teams : []
  if (manifest.teams !== undefined && !Array.isArray(manifest.teams)) {
    report.error('MT_PLUGIN_MANIFEST_INVALID', 'teams 必须是数组', { path: manifestPath })
  }
  /* 模板可引用：本插件贡献的角色 ∪ 调用方已知角色（builtin / 全局库 / 项目库） */
  const resolvableRoleIds = new Set([...roleIds, ...(opts.knownRoleIds ?? [])])

  for (const [index, item] of teamList.entries()) {
    const where = `teams[${index}]`
    if (!item || typeof item !== 'object') {
      report.error('MT_PLUGIN_MANIFEST_INVALID', `${where} 必须是对象 {id, file}`, { path: manifestPath })
      continue
    }
    const declaredId = typeof item.id === 'string' ? item.id : ''
    if (!SAFE_ID_RE.test(declaredId) || declaredId.includes('..')) {
      report.error('MT_PLUGIN_MANIFEST_INVALID', `${where}.id 不合规：${JSON.stringify(item.id)}`, { path: manifestPath })
      continue
    }
    if (!isSafeRelativeFile(item.file)) {
      report.error('MT_CONTRIBUTION_PATH_TRAVERSAL', `${where}.file 必须是插件目录内的相对路径：${JSON.stringify(item.file)}`, { path: manifestPath })
      continue
    }
    const teamPath = resolveInside(dir, item.file)
    if (!teamPath) {
      report.error('MT_CONTRIBUTION_PATH_TRAVERSAL', `${where}.file 解析后越出插件目录：${item.file}`, { path: manifestPath })
      continue
    }
    const team = readJson(teamPath, report, 'MT_CONTRIBUTION_FILE_MISSING')
    if (!team) continue

    if (team.id !== declaredId) {
      report.error('MT_CONTRIBUTION_ID_MISMATCH', `${item.file} 内 id="${team.id}" 与清单声明 "${declaredId}" 不一致`, { path: teamPath })
      continue
    }
    if (BUILTIN_TEMPLATE_IDS.has(declaredId)) {
      report.error('MT_TEAM_TEMPLATE_CONFLICT', `团队模板 "${declaredId}" 与内置模板冲突；请改用带前缀的 id`, { path: teamPath, conflictsWith: 'builtin' })
      continue
    }
    if (teamIds.has(declaredId) || opts.knownTeamIds?.has(declaredId)) {
      report.error('MT_TEAM_TEMPLATE_CONFLICT', `团队模板 "${declaredId}" 重复声明或与其它插件冲突`, { path: teamPath })
      continue
    }
    if (!isNonEmptyString(team.name)) {
      report.error('MT_PLUGIN_MANIFEST_INVALID', `团队模板 "${declaredId}" 缺少 name`, { path: teamPath })
      continue
    }
    if (!Array.isArray(team.members) || team.members.length === 0) {
      report.error('MT_PLUGIN_MANIFEST_INVALID', `团队模板 "${declaredId}" 的 members 必须是非空数组`, { path: teamPath })
      continue
    }
    const unresolved = []
    let captainInMembers = false
    for (const [mIndex, member] of team.members.entries()) {
      const roleId = member?.roleId
      if (typeof roleId !== 'string' || roleId.length === 0) {
        report.error('MT_PLUGIN_MANIFEST_INVALID', `团队模板 "${declaredId}" members[${mIndex}].roleId 缺失`, { path: teamPath })
        continue
      }
      if (roleId === 'captain') { captainInMembers = true; continue }
      if (!resolvableRoleIds.has(roleId)) unresolved.push(roleId)
    }
    if (captainInMembers) {
      report.error('MT_TEAM_TEMPLATE_CAPTAIN', `团队模板 "${declaredId}" 的 members 不能含 captain（队长由预设隐式提供）`, { path: teamPath })
      continue
    }
    if (unresolved.length > 0) {
      report.error(
        'MT_TEAM_TEMPLATE_UNRESOLVED',
        `团队模板 "${declaredId}" 引用了不可解析的角色：${[...new Set(unresolved)].map((id) => `"${id}"`).join(', ')}——请在同一个插件里贡献它，或确认它来自 builtin / 全局库 / 项目库`,
        { path: teamPath },
      )
      continue
    }

    teamIds.add(declaredId)
    teams.push({ id: declaredId, definition: team, filePath: teamPath })
  }

  /* 8. 其它可执行文件：不执行，只提示 */
  try {
    const stray = readdirSync(dir).filter((name) => /\.(c|m)?js$/i.test(name))
    if (stray.length > 0) {
      report.info('MT_CONTRIBUTION_CODE_IGNORED', `插件目录含可执行文件（${stray.join(', ')}）——myteam 只读 JSON，不会执行它们`, { path: dir })
    }
  } catch { /* 目录不可读已被上层处理 */ }

  const plugin = {
    pluginId,
    displayName: manifest.displayName,
    version: manifest.version,
    namespace,
    dir,
    description: manifest.description,
    homepage: manifest.homepage,
    requires: manifest.requires,
    roles: roles.map((r) => r.id),
    teams: teams.map((t) => t.id),
    status: report.ok ? 'ok' : 'invalid',
  }

  return { plugin, roles, teams, report }
}

/* ── 根目录：逐插件校验 ───────────────────────────────────────────── */

/**
 * 校验 plugins 根目录（含多个 <pluginId>/ 子目录）。
 * @param {string} root
 */
export function checkContributionsRoot(root) {
  const report = createReport()
  if (!existsSync(root)) {
    report.info('MT_CONTRIBUTION_ROOT_ABSENT', `贡献根目录不存在（没有插件贡献，这是正常的）：${root}`)
    return { root, plugins: [], roles: [], teams: [], report }
  }

  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort() // 确定性：冲突时「后者」= 字典序更大者

  const plugins = []
  const roles = []
  const teams = []
  const seenPluginIds = new Set()
  const knownRoleIds = new Set(BUILTIN_ROLE_IDS)
  const knownTeamIds = new Set(BUILTIN_TEMPLATE_IDS)

  for (const name of dirs) {
    const dir = join(root, name)
    const result = checkContribution(dir, {
      knownRoleIds,
      knownTeamIds,
      otherPluginIds: seenPluginIds,
    })
    for (const finding of result.report.findings) {
      report.findings.push({ ...finding, pluginId: result.plugin?.pluginId ?? name })
    }
    if (!result.plugin) continue
    seenPluginIds.add(result.plugin.pluginId)
    for (const role of result.roles) knownRoleIds.add(role.id)
    for (const team of result.teams) knownTeamIds.add(team.id)
    plugins.push(result.plugin)
    roles.push(...result.roles)
    teams.push(...result.teams)
  }

  /* 跨插件角色冲突（第二遍，确保已收集全部 id） */
  const byRoleId = new Map()
  for (const role of roles) {
    const list = byRoleId.get(role.id) ?? []
    list.push(role.filePath)
    byRoleId.set(role.id, list)
  }
  for (const [roleId, files] of byRoleId) {
    if (files.length > 1) {
      report.error('MT_ROLE_CONTRIBUTION_CONFLICT', `角色 "${roleId}" 被多个插件贡献：${files.join(' / ')}`, { path: files[1] })
    }
  }

  return { root, plugins, roles, teams, report }
}

/* ── CLI ──────────────────────────────────────────────────────────── */

function main(argv) {
  const args = argv.slice(2)
  const asJson = args.includes('--json')
  const asRoot = args.includes('--root')
  const target = args.find((arg) => !arg.startsWith('--'))

  if (!target) {
    console.error('用法：node check-contribution.mjs <贡献目录|plugins 根目录> [--json] [--root]')
    return 2
  }

  const abs = resolve(target)
  const result = asRoot ? checkContributionsRoot(abs) : (() => {
    const single = checkContribution(abs)
    const report = single.report
    return {
      root: dirname(abs),
      plugins: single.plugin ? [single.plugin] : [],
      roles: single.roles,
      teams: single.teams,
      report,
    }
  })()

  if (asJson) {
    console.log(JSON.stringify({
      root: result.root,
      ok: result.report.ok,
      plugins: result.plugins,
      roles: result.roles.map((r) => r.id),
      teams: result.teams.map((t) => t.id),
      findings: result.report.findings,
    }, null, 2))
    return result.report.ok ? 0 : 1
  }

  const line = (level, finding) => {
    const icon = level === 'error' ? '✖' : level === 'warn' ? '⚠' : 'ℹ'
    const where = finding.path ? ` [${relative(process.cwd(), finding.path) || finding.path}]` : ''
    return `${icon} ${finding.code}: ${finding.message}${where}`
  }

  console.log(`贡献根目录：${result.root}`)
  console.log(`插件：${result.plugins.length} 个 · 角色：${result.roles.length} 个 · 团队模板：${result.teams.length} 个`)
  for (const plugin of result.plugins) {
    console.log(`  · ${plugin.pluginId} v${plugin.version}（${plugin.displayName}）角色 ${plugin.roles.length} / 模板 ${plugin.teams.length}`)
  }
  if (result.report.findings.length > 0) {
    console.log('')
    for (const finding of result.report.findings) console.log(line(finding.level, finding))
  }
  console.log('')
  console.log(result.report.ok
    ? `✅ 通过（${result.report.warnings.length} 条 warning）`
    : `❌ 失败：${result.report.errors.length} 个 error（这些条目会被 myteam 跳过）`)
  return result.report.ok ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('check-contribution.mjs')) {
  process.exitCode = main(process.argv)
}
