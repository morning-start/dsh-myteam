/**
 * 全局发布（项目 → `$DSH_HOME/myteam`）的端口契约。
 *
 * 为什么放在 contracts：应用层的用例要调它，infrastructure 的文件写入器要实现它，
 * 两边都只能依赖 contracts——架构门禁不允许 application 依赖 infrastructure，也不允许
 * infrastructure 反向依赖用例。
 */
export type PublicationKind = 'role' | 'workflow' | 'blueprint'

export interface GlobalPublishInput {
  kind: PublicationKind
  id: string
  /** 定义对象本体；序列化与内容 hash 由实现负责，用例只管交内容。 */
  definition: unknown
  operationId: string
  revision: number
  sourceProjectId: string
  publishedAt: string
}

export interface GlobalPublishResult {
  /** 相对全局库根的路径，例如 `roles/role_1.json`。 */
  file: string
  globalHash: string
}

export interface GlobalPublicationPort {
  /** 全局库里是否已有该条目。发布前用来判断「这次是覆盖」。 */
  exists(kind: PublicationKind, id: string): boolean
  /** 原子写入定义文件，并追加一条操作审计。 */
  publish(input: GlobalPublishInput): GlobalPublishResult
}