/**
 * 项目 manifest 的读取与创建。
 *
 * manifest 是**布局身份**：`projectId` 在初始化时生成，工作区移动不变；
 * `layoutVersion/schemaVersion` 决定这份数据能不能被当前代码解释。
 *
 * 读到 v1 manifest 时直接拒绝打开，而不是「顺手升级」：升级涉及整套数据
 * 迁移（事件、SQLite、知识），静默改写会让迁移器失去原始输入。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ProjectManifest } from '../../contracts/entities.ts'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { LAYOUT_VERSION, MANIFEST_FILE, SCHEMA_VERSION } from '../../contracts/versions.ts'

export function manifestPathOf(rootDir: string): string {
  return join(rootDir, MANIFEST_FILE)
}

export function readProjectManifest(rootDir: string): ProjectManifest | null {
  const path = manifestPathOf(rootDir)
  if (!existsSync(path)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail(ERROR_CODES.MANIFEST_INVALID, '项目 manifest 不是合法 JSON', { details: { path } })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    fail(ERROR_CODES.MANIFEST_INVALID, '项目 manifest 结构不合法', { details: { path } })
  }
  const record = parsed as Record<string, unknown>
  const schemaVersion = record.schemaVersion
  if (schemaVersion !== SCHEMA_VERSION) {
    fail(ERROR_CODES.MANIFEST_INVALID, `项目数据版本为 ${String(schemaVersion)}，当前代码只支持 v${SCHEMA_VERSION}`, {
      details: { path, schemaVersion: typeof schemaVersion === 'number' ? schemaVersion : null, hint: '旧布局需要先执行一次性迁移' },
    })
  }
  const projectId = record.projectId
  const name = record.name
  const layoutVersion = record.layoutVersion
  if (typeof projectId !== 'string' || typeof name !== 'string' || typeof layoutVersion !== 'number') {
    fail(ERROR_CODES.MANIFEST_INVALID, '项目 manifest 缺少 projectId/name/layoutVersion', { details: { path } })
  }

  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString()
  return { projectId, name, layoutVersion, schemaVersion: SCHEMA_VERSION, createdAt }
}

/**
 * 读取或创建 manifest。
 *
 * 创建是「首次打开一个还没有 myteam 数据的项目」：写入 projectId 与布局版本，
 * 不写任何业务事件。业务初始化（`project.initialized`）仍由命令完成。
 */
export function ensureProjectManifest(rootDir: string, input: { projectId: string; name?: string; createdAt: string }): ProjectManifest {
  const existing = readProjectManifest(rootDir)
  if (existing !== null) return existing

  const path = manifestPathOf(rootDir)
  mkdirSync(dirname(path), { recursive: true })
  const manifest: ProjectManifest = {
    projectId: input.projectId,
    name: input.name ?? basename(rootDir),
    layoutVersion: LAYOUT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: input.createdAt,
  }

  const tempPath = `${path}.tmp-${process.pid}`
  const fd = openSync(tempPath, 'w')
  try {
    writeSync(fd, JSON.stringify(manifest, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  // rename 保证同名文件不会出现半截内容（Windows 同卷 rename 是原子的）。
  renameSync(tempPath, path)
  return manifest
}