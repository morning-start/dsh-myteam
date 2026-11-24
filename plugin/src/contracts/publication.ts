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

/**
 * 全局库「直改」输入（`definition.publish` 之外的第二条全局写路径）。
 *
 * 与发布的区别：发布是「项目副本 → 全局库」，源头是项目；直改是「全局库 → 全局库」，
 * 没有项目参与。两者的审计 action 不同（`definition.publish` vs `definition.edit`），
 * 但共用同一段原子写与同一个审计文件 —— 谁写的都必须留痕。
 */
export interface GlobalEditInput {
  kind: PublicationKind
  id: string
  /** 完整定义本体；序列化与 hash 由实现负责。 */
  definition: unknown
  revision: number
  operationId: string
  /**
   * 调用方看到的当前文件 hash；**新建时传 null**（表示「我预期这里还没有文件」）。
   * 与磁盘不一致即拒绝（并发保护），不自动合并。
   */
  expectedHash: string | null
  editedAt: string
  /** 谁改的（人类入口标识），写进审计。 */
  editor: string
}

export interface GlobalEditResult {
  file: string
  globalHash: string
  /** 改之前的文件 hash；新建时为 null。 */
  previousHash: string | null
}

/**
 * 全局库直改端口。
 *
 * 为什么不并进 `GlobalPublicationPort`：发布与直改的**前置条件不同**（发布要项目副本与
 * 影响面预览，直改要 expectedHash），硬塞成一个方法会让调用方各自判断「现在该传哪些字段」。
 * 分开两个端口，实现里共用同一段写入与审计函数。
 */
/**
 * 下架（unpublish）—— 只影响**目录可见性**，不删文件。
 *
 * 设计稿 g-role / g-workflow / g-blueprint 原话：「下架只是不再出现在目录里；
 * 已被引用的工作流与蓝图仍能读到这一版。」
 *
 * 所以它不是删除：文件与审计都留着，只多一条 `definition.unpublish` 记录与一个
 * 「不在目录里」的标记（用同目录下的 `_hidden.json` 索引表达，不移动文件 —— 移动会让
 * 引用方读不到，正好违背语义）。
 */
export interface GlobalUnpublishInput {
  kind: PublicationKind
  id: string
  operationId: string
  expectedHash: string
  unpublishedAt: string
  editor: string
}

export interface GlobalLibraryEditPort {
  /** 读当前文件 hash；不存在返回 null。用于预览与冲突检测。 */
  readFileHash(kind: PublicationKind, id: string): string | null
  /** 原子写入 + 追加审计；`expectedHash` 与磁盘不一致时抛 CONFLICT。 */
  writeFile(input: GlobalEditInput): GlobalEditResult
  /** 下架：只标记「不在目录里」，文件与审计都留着。`expectedHash` 不符同样拒绝。 */
  unpublish(input: GlobalUnpublishInput): { file: string; hidden: true }
  /** 当前下架标记里的 id 列表（读全局库时用来过滤目录）。 */
  hiddenIds(kind: PublicationKind): string[]
}