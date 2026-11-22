/**
 * 全局库（`$DSH_HOME/myteam`）只读读取器。
 *
 * 为什么单独一层：全局资产不属任何项目，也**不在事件日志里**——它是文件系统上的
 * 定义库（角色 / 工作流 / 蓝图 / 旧的 teams）+ 一份只记操作的审计日志。面板读它
 * 时不能借项目投影，所以这里直接按目录结构读，并把「读不懂的文件」如实列成 warning，
 * 而不是静默丢条目。
 *
 * 只读：本模块不写、不建目录、不改文件。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 逐个目录扫描的候选（`teams/` 是 v1 发布格式，只读兼容）。 */
const KIND_DIRS = [
  { kind: 'role', dir: 'roles', legacy: false },
  { kind: 'workflow', dir: 'workflows', legacy: false },
  { kind: 'blueprint', dir: 'blueprints', legacy: false },
  { kind: 'team', dir: 'teams', legacy: true },
] as const

export type GlobalEntryKind = (typeof KIND_DIRS)[number]['kind']

export interface GlobalEntry {
  kind: GlobalEntryKind
  id: string
  name: string
  revision: number | null
  /** 相对全局根的文件路径（`roles/x.json`）。 */
  file: string
  /** v1 发布格式留下的 `teams/*.json`：能读，但不当作蓝图使用。 */
  legacy: boolean
}

export interface GlobalWarning {
  file: string
  reason: string
}

export interface GlobalLibraryView {
  root: string
  exists: boolean
  counts: Record<GlobalEntryKind, number>
  entries: GlobalEntry[]
  warnings: GlobalWarning[]
}

/**
 * 解析全局库根目录：`$DSH_HOME/myteam`，`DSH_HOME` 缺省时回落到 `~/.dsh`。
 * @param env - 进程环境（测试可注入）。
 * @param home - 用户主目录（测试可注入）。
 * @returns 绝对路径。
 */
export function globalLibraryRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env.DSH_HOME?.trim()
  const base = configured === undefined || configured === '' ? join(home, '.dsh') : configured
  return join(base, 'myteam')
}

/** 从任意 JSON 里取一个非空字符串字段。 */
function pickString(value: unknown, keys: readonly string[]): string | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const field = record[key]
    if (typeof field === 'string' && field.length > 0) return field
  }
  return null
}

/** 从定义文件里取名字：角色在 `profile.name`，其余在顶层 `name`。 */
function displayName(parsed: unknown, id: string): string {
  if (typeof parsed === 'object' && parsed !== null) {
    const profile = (parsed as { profile?: unknown }).profile
    const fromProfile = pickString(profile, ['name'])
    if (fromProfile !== null) return fromProfile
  }
  return pickString(parsed, ['name', 'title']) ?? id
}

/**
 * 读一份定义文件。
 * @param root - 全局库根。
 * @param kind - 定义种类。
 * @param dir - 目录名。
 * @param file - 文件名。
 * @param legacy - 是否 v1 兼容目录。
 * @param warnings - 读不懂的文件收进这里。
 */
function readEntry(
  root: string,
  kind: GlobalEntryKind,
  dir: string,
  file: string,
  legacy: boolean,
  warnings: GlobalWarning[],
): GlobalEntry | null {
  const relative = `${dir}/${file}`
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(root, dir, file), 'utf8')) as unknown
  } catch (error) {
    warnings.push({ file: relative, reason: error instanceof Error ? error.message : String(error) })
    return null
  }
  const fromFile = file.replace(/\.json$/u, '')
  const id = pickString(parsed, ['id', 'roleId', 'workflowId', 'blueprintId']) ?? fromFile
  const revisionField = (parsed as { revision?: unknown } | null)?.revision
  return {
    kind,
    id,
    name: displayName(parsed, id),
    revision: typeof revisionField === 'number' && Number.isFinite(revisionField) ? revisionField : null,
    file: relative,
    legacy,
  }
}

/**
 * 读整个全局库。
 * @param root - 全局库根目录（{@link globalLibraryRoot}）。
 * @returns 计数、条目与读不懂的文件清单；目录不存在时 `exists: false`，不抛错。
 */
export function readGlobalLibrary(root: string): GlobalLibraryView {
  const counts: Record<GlobalEntryKind, number> = { role: 0, workflow: 0, blueprint: 0, team: 0 }
  const entries: GlobalEntry[] = []
  const warnings: GlobalWarning[] = []
  if (!existsSync(root)) return { root, exists: false, counts, entries, warnings }

  for (const { kind, dir, legacy } of KIND_DIRS) {
    const directory = join(root, dir)
    if (!existsSync(directory)) continue
    let names: string[]
    try {
      names = readdirSync(directory).filter((name) => name.endsWith('.json'))
    } catch (error) {
      warnings.push({ file: dir, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    for (const name of names.sort()) {
      const entry = readEntry(root, kind, dir, name, legacy, warnings)
      if (entry === null) continue
      entries.push(entry)
      counts[kind] += 1
    }
  }
  entries.sort((left, right) => (left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind.localeCompare(right.kind)))
  return { root, exists: true, counts, entries, warnings }
}

export interface GlobalAuditItem {
  at: string | null
  operationId: string | null
  action: string | null
  target: string | null
  status: string | null
  /** 原始行，界面需要看细节时不必再请求一次。 */
  record: unknown
}

export interface GlobalAuditView {
  root: string
  exists: boolean
  items: GlobalAuditItem[]
  /** 文件比本次返回的条数还多：界面据此显示「还有更早的」。 */
  truncated: boolean
  warnings: GlobalWarning[]
}

/**
 * 读全局操作审计（`audit/global-operations.jsonl`），新→旧。
 *
 * 它只记录操作，**不是定义的读取源**；坏行跳过并记 warning，不让一行坏数据把
 * 整个全局页打成空白。
 * @param root - 全局库根。
 * @param limit - 最多返回多少条（1..500）。
 */
export function readGlobalAudit(root: string, limit = 50): GlobalAuditView {
  const file = join(root, 'audit', 'global-operations.jsonl')
  const warnings: GlobalWarning[] = []
  if (!existsSync(file)) return { root, exists: false, items: [], truncated: false, warnings }
  const bounded = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 50

  let lines: string[]
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/u).filter((line) => line.trim() !== '')
  } catch (error) {
    warnings.push({ file: 'audit/global-operations.jsonl', reason: error instanceof Error ? error.message : String(error) })
    return { root, exists: false, items: [], truncated: false, warnings }
  }

  const items: GlobalAuditItem[] = []
  // 从文件尾往前扫：坏行不占名额，扫到够数或扫完为止；还剩没扫的就是「更早的」。
  let index = lines.length - 1
  while (index >= 0 && items.length < bounded) {
    const line = lines[index]!
    index -= 1
    let record: unknown
    try {
      record = JSON.parse(line) as unknown
    } catch {
      warnings.push({ file: 'audit/global-operations.jsonl', reason: '坏行（不是 JSON）' })
      continue
    }
    items.push({
      at: pickString(record, ['at', 'ts', 'recordedAt', 'occurredAt']),
      operationId: pickString(record, ['operationId', 'op', 'id']),
      action: pickString(record, ['action', 'operation', 'kind', 'event']),
      target: pickString(record, ['target', 'path', 'file']),
      status: pickString(record, ['status', 'result', 'outcome']),
      record,
    })
  }
  return { root, exists: true, items, truncated: index >= 0, warnings }
}