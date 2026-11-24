/**
 * 项目数据销毁的端口契约。
 *
 * 为什么放在 contracts：应用层的用例要调它，infrastructure 的文件删除器要实现它，
 * 两边都只能依赖 contracts —— 架构门禁不允许 application 依赖 infrastructure
 * （刚被 `check-architecture` 抓到过一次，把端口写在 infrastructure 里直接违规）。
 *
 * 与 `publication.ts` 同一个道理：端口是「谁调谁实现」之间的接缝，接缝本身不属于任何一边。
 */

export interface DestroyTarget {
  /** 相对项目根的路径，例如 `.dsh-myteam/events/project.jsonl`。 */
  path: string
  bytes: number
  what: string
}

export interface DestroyPreview {
  rootDir: string
  /** 从 manifest 读到的项目名（不是目录名：两者可以不同）。 */
  name: string
  projectId: string
  /** 将要删除的东西，逐项给人看。 */
  targets: DestroyTarget[]
  totalBytes: number
  /** 删除后**不会**恢复的东西，逐条写清楚。 */
  irreversible: string[]
}

export interface DestroyResult {
  destroyed: true
  rootDir: string
  projectId: string
  name: string
  /** 删掉的字节数（预览时算过的那份）。 */
  bytes: number
  auditAt: string
}

export interface ProjectDestroyPort {
  /** 读影响面（不删任何东西）。 */
  preview(rootDir: string): DestroyPreview
  /**
   * 执行销毁。
   *
   * 实现方必须按固定顺序做：**先写全局审计 → 再关运行时 → 最后删目录**。
   * 项目的账本正是被删的东西，所以销毁记录只能写进全局审计，而且必须在删除前写：
   * 删除失败时那条记录还能说明「有人尝试过」。
   *
   * @param input.expectedName - 人类输入的项目名；与 manifest 不符则拒绝。
   * @param input.closeRuntime - 先关掉运行时（释放写者租约）。
   */
  destroy(input: {
    rootDir: string
    expectedName: string
    operationId: string
    auditAt: string
    actor: string
    closeRuntime: () => Promise<boolean>
  }): Promise<DestroyResult>
}
