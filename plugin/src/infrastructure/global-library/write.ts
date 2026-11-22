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
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
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

      const directory = join(root, KIND_DIR[input.kind])
      mkdirSync(directory, { recursive: true })
      const target = join(root, relative)
      const temporary = `${target}.tmp-${process.pid}`
      writeFileSync(temporary, text, { encoding: 'utf8' })
      // rename 覆盖是原子的：读的人不会看到写了一半的定义。
      renameSync(temporary, target)

      const auditDir = join(root, 'audit')
      mkdirSync(auditDir, { recursive: true })
      appendFileSync(
        join(auditDir, 'global-operations.jsonl'),
        `${JSON.stringify({
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
        })}\n`,
        { encoding: 'utf8' },
      )

      return { file: relative, globalHash }
    },
  }
}