/**
 * 全局库写入器（发布用实现）。
 *
 * 与只读视图 `library.ts` 分开：写路径要落定义文件 **并且** 追加操作审计，两件事
 * 顺序固定——先原子写文件，再记审计；记审计失败就抛错，让用例把 outcome 记成 failed，
 * 而不是悄悄留一个「文件写了但没人知道」的状态。
 *
 * 只写 `roles/` `workflows/` `blueprints/` 三个目录。`teams/` 是 v1 发布格式的
 * 只读兼容目录，不从这里写。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import type {
  GlobalEditInput,
  GlobalEditResult,
  GlobalLibraryEditPort,
  GlobalPublicationPort,
  GlobalPublishInput,
  GlobalPublishResult,
  PublicationKind,
} from '../../contracts/publication.ts'

const KIND_DIR: Readonly<Record<PublicationKind, string>> = {
  role: 'roles',
  workflow: 'workflows',
  blueprint: 'blueprints',
}

/** 定义文件在全局库里的相对路径。 */
export function globalEntryFile(kind: PublicationKind, id: string): string {
  return `${KIND_DIR[kind]}/${id}.json`
}

/** 内容 hash：与 publish 用同一个算法，保证两处算出来可比。 */
function hashOf(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 原子写：临时名 → rename。读的人不会看到写了一半的定义。 */
function writeAtomic(root: string, relative: string, text: string): void {
  const directory = join(root, relative.split('/')[0]!)
  mkdirSync(directory, { recursive: true })
  const target = join(root, relative)
  const temporary = target + '.tmp-' + String(process.pid)
  writeFileSync(temporary, text, { encoding: 'utf8' })
  renameSync(temporary, target)
}

/**
 * 追加一条全局操作审计。
 *
 * 单独抽出来是为了让 publish 与 writeFile 走同一段写法 —— 审计格式一旦分叉，
 * 「全局库每次变化都有记录」这条不变量就靠不住了。
 */
function appendAudit(root: string, record: Record<string, unknown>): void {
  const auditDir = join(root, 'audit')
  mkdirSync(auditDir, { recursive: true })
  appendFileSync(join(auditDir, 'global-operations.jsonl'), JSON.stringify(record) + '\n', { encoding: 'utf8' })
}

/**
 * 建一个全局库发布器。
 * @param root - 全局库根目录（`globalLibraryRoot()`）。
 */
export function createGlobalPublisher(root: string): GlobalPublicationPort {
  return {
    exists(kind: PublicationKind, id: string): boolean {
      return existsSync(join(root, KIND_DIR[kind], `${id}.json`))
    },
    publish(input: GlobalPublishInput): GlobalPublishResult {
      const relative = globalEntryFile(input.kind, input.id)
      const text = `${JSON.stringify(input.definition, null, 2)}\n`
      const globalHash = `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`

      writeAtomic(root, relative, text)
      appendAudit(root, {
        at: input.publishedAt,
        operationId: input.operationId,
        action: 'definition.publish',
        target: relative,
        status: 'published',
        kind: input.kind,
        id: input.id,
        revision: input.revision,
        globalHash,
        sourceProjectId: input.sourceProjectId,
      })

      return { file: relative, globalHash }
    },
  }
}

/**
 * 建一个全局库直改器（definition.publish 之外的第二条全局写路径）。
 *
 * 与发布共用 writeAtomic 与 appendAudit：写盘与留痕的说法只有一处，
 * 两边不可能长出不同的审计格式。差别只在**前置条件**与**审计 action**：
 *   - 发布：源头是项目副本，action = definition.publish；
 *   - 直改：源头是全局库自己，要求 expectedHash 与磁盘一致，action = definition.edit。
 *
 * @param root - 全局库根目录（globalLibraryRoot()）。
 */
export function createGlobalEditor(root: string): GlobalLibraryEditPort {
  return {
    readFileHash(kind: PublicationKind, id: string): string | null {
      const target = join(root, globalEntryFile(kind, id))
      if (!existsSync(target)) return null
      return hashOf(readFileSync(target, 'utf8'))
    },
    writeFile(input: GlobalEditInput): GlobalEditResult {
      const relative = globalEntryFile(input.kind, input.id)
      const target = join(root, relative)
      const existing = existsSync(target) ? readFileSync(target, 'utf8') : null
      const previousHash = existing === null ? null : hashOf(existing)

      // 并发保护：调用方看到的版本必须还是磁盘上的版本。不一致就拒绝，不自动合并 ——
      // 两个并发编辑的 JSON 自动合并最容易产出「字段都在但语义不通」的结果。
      if (previousHash !== input.expectedHash) {
        const shorten = (hash: string | null) => (hash === null ? '不存在' : hash.slice(0, 16) + '…')
        fail(
          ERROR_CODES.CONFLICT,
          '全局库里的 ' + relative + ' 已经被别人改过了（期望 ' + shorten(input.expectedHash) +
            '，实际 ' + shorten(previousHash) + '）；重新载入后再改',
          { details: { kind: input.kind, id: input.id, expectedHash: input.expectedHash, actualHash: previousHash } },
        )
      }

      const text = JSON.stringify(input.definition, null, 2) + '\n'
      const globalHash = hashOf(text)
      writeAtomic(root, relative, text)
      appendAudit(root, {
        at: input.editedAt,
        operationId: input.operationId,
        action: 'definition.edit',
        target: relative,
        status: 'edited',
        kind: input.kind,
        id: input.id,
        revision: input.revision,
        globalHash,
        previousHash,
        editor: input.editor,
      })
      return { file: relative, globalHash, previousHash }
    },
  }
}
