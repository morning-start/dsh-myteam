/**
 * 项目数据销毁（`project.destroy`）—— 不可逆。
 *
 * 设计稿 `p-settings` 原话：「删除事件日志、SQLite 与生成视图，不可撤销。
 * 只在你确实要丢掉整个项目历史时使用；归档只是停止写入。」
 *
 * 这一层刻意做成**端口**而不是直接写 fs：销毁要按固定顺序做（先关运行时、
 * 再写审计、最后删目录），顺序错了会出现「日志没了但锁还在」「删了一半」这类
 * 中间态。端口把顺序封在一处，用例层只负责校验与授权。
 *
 * 三条不变量：
 *   1. **先记审计，再删**。项目的账本正是被删掉的东西，所以销毁记录只能写进
 *      `$DSH_HOME/myteam/audit/global-operations.jsonl`（全局审计），而且必须在删除前写：
 *      删除失败时那条记录还能说明「有人尝试过」。
 *   2. **必须能证明你删的是哪个项目**：`expectedName` 与 manifest 里的名字不符就拒绝。
 *      只靠一个 id 不够 —— 人手滑选错工作区时，id 看起来都差不多。
 *   3. **先关运行时**。写者租约在 `.dsh-myteam/state/writer.lock`，运行时开着就删目录，
 *      租约文件会以「被删掉」而不是「被释放」收场，下一个进程会看到悬空锁。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { EVENTS_FILE, MANIFEST_FILE, PROJECTIONS_DIR, WORKSPACE_DIR } from '../../contracts/versions.ts'
import type { DestroyPreview, DestroyResult, ProjectDestroyPort } from '../../contracts/project-destroy.ts'

/** 目录里所有文件的字节数（只算文件，不算目录本身）。 */
function sizeOf(path: string): { bytes: number; files: number } {
  if (!existsSync(path)) return { bytes: 0, files: 0 }
  const stat = statSync(path)
  if (stat.isFile()) return { bytes: stat.size, files: 1 }
  let bytes = 0
  let files = 0
  for (const name of readdirSync(path)) {
    const child = sizeOf(join(path, name))
    bytes += child.bytes
    files += child.files
  }
  return { bytes, files }
}

/** 读 manifest 里的项目名与 id；读不到就明确报错，不猜。 */
function readManifest(rootDir: string): { name: string; projectId: string } {
  const file = join(rootDir, MANIFEST_FILE)
  if (!existsSync(file)) {
    fail(ERROR_CODES.PROJECT_NOT_INITIALIZED, '这个工作区没有项目 manifest，不是可销毁的项目', {
      details: { rootDir },
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(ERROR_CODES.MANIFEST_INVALID, 'manifest.json 读不懂，拒绝销毁（先修好它再决定）', {
      details: { reason: error instanceof Error ? error.message : String(error) },
    })
  }
  const record = parsed as Record<string, unknown>
  const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : ''
  const projectId = typeof record.projectId === 'string' ? record.projectId : ''
  if (projectId.length === 0) {
    fail(ERROR_CODES.MANIFEST_INVALID, 'manifest.json 缺 projectId，拒绝销毁')
  }
  return { name: name.length > 0 ? name : projectId, projectId }
}

/**
 * 建一个项目数据销毁器。
 * @param auditFile - 全局审计文件（`$DSH_HOME/myteam/audit/global-operations.jsonl`）。
 */
export function createProjectDestroyer(auditFile: string): ProjectDestroyPort {
  // 抽成局部函数：destroy 里要用 preview，但对象方法里的 this 在被解构调用时会丢失
  // （真实踩过：TypeError: The "path" argument must be of type string. Received undefined）。
  function previewOf(rootDir: string): DestroyPreview {
      const { name, projectId } = readManifest(rootDir)
      const targets: DestroyPreview['targets'] = []
      const add = (relative: string, what: string) => {
        const full = join(rootDir, relative)
        if (!existsSync(full)) return
        const { bytes, files } = sizeOf(full)
        targets.push({ path: relative, bytes, what: files > 1 ? `${what}（${String(files)} 个文件）` : what })
      }
      add(EVENTS_FILE, '事件日志（全部历史）')
      add('memory/memory.db', '长期记忆库')
      add('history/memory.db', 'v1 遗留记忆库')
      add(PROJECTIONS_DIR, '派生投影')
      add(`${WORKSPACE_DIR}/state/writer.lock`, '写者租约')

      const totalBytes = targets.reduce((sum, item) => sum + item.bytes, 0)
      return {
        rootDir,
        name,
        projectId,
        targets,
        totalBytes,
        irreversible: [
          '事件日志删除后，项目里的团队、任务、定义、知识、记忆与审计全部消失',
          '长期记忆库（SQLite）一并删除；成员 bank 里的记忆不会保留',
          '删除后这个工作区不再是项目：下次打开会重新初始化一个空项目',
          '没有回收站，也没有备份 —— 这是不可撤销的',
        ],
      }
  }

  return {
    preview: previewOf,

    async destroy(input): Promise<DestroyResult> {
      const { name, projectId } = readManifest(input.rootDir)
      // 名字不符就拒绝：这一条必须在这里做，不能只靠界面拦。
      if (input.expectedName.trim() !== name) {
        fail(ERROR_CODES.PRECONDITION_FAILED, '输入的项目名与 manifest 不一致，拒绝销毁', {
          details: { expected: input.expectedName, actual: name },
        })
      }

      const preview = previewOf(input.rootDir)

      // 顺序固定：先记审计（写全局审计，因为项目的账本马上要被删），再关运行时，最后删目录。
      appendAudit(auditFile, {
        at: input.auditAt,
        operationId: input.operationId,
        action: 'project.destroy',
        target: input.rootDir,
        status: 'destroying',
        projectId,
        name,
        bytes: preview.totalBytes,
        targets: preview.targets.map((item) => item.path),
        actor: input.actor,
      })

      // 关运行时：不关就删目录，写者租约文件会以「被删掉」而不是「被释放」收场，
      // 下一个进程会看到悬空锁。
      await input.closeRuntime()

      try {
        rmSync(input.rootDir, { recursive: true, force: true })
      } catch (error) {
        appendAudit(auditFile, {
          at: input.auditAt,
          operationId: input.operationId,
          action: 'project.destroy',
          target: input.rootDir,
          status: 'failed',
          projectId,
          name,
          reason: error instanceof Error ? error.message : String(error),
          actor: input.actor,
        })
        fail(ERROR_CODES.EVENT_LOG_UNWRITABLE, '删除项目数据失败', {
          details: { reason: error instanceof Error ? error.message : String(error) },
        })
      }

      appendAudit(auditFile, {
        at: input.auditAt,
        operationId: input.operationId,
        action: 'project.destroy',
        target: input.rootDir,
        status: 'destroyed',
        projectId,
        name,
        bytes: preview.totalBytes,
        actor: input.actor,
      })

      return { destroyed: true, rootDir: input.rootDir, projectId, name, bytes: preview.totalBytes, auditAt: input.auditAt }
    },
  }
}

/** 追加全局审计（与全局库写操作同一个文件，格式一致）。 */
function appendAudit(file: string, record: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8' })
}
