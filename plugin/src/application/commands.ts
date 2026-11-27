/**
 * 项目用例（命令层）：只做「解析意图 → 领域校验 → 产出事件」。
 *
 * 这里没有文件、没有 DSH、没有面板协议；同一个函数被队长工具、面板 RPC 和
 * 测试调用，因此三者不可能出现「面板能建、工具不能建」这种分叉。
 *
 * ── 本文件是聚合入口，不是实现 ────────────────────────────────────────────────
 * 实现按聚合拆在 `commands/` 下（每个文件的头注释说明它管哪一块），这里只做重导出，
 * 保证历史上 `./commands.ts` 的导入面一个字都不用改：
 *
 *   project.ts      初始化项目
 *   definitions.ts  角色 / 工作流 / 蓝图的建立与修订
 *   team.ts         团队生命周期：建队、改状态、配置 rebase
 *   team-plan.ts    建队计划：提出 / 批准 / 丢弃，以及队长交接建议
 *   task.ts         任务 DAG：建任务、认领任务、任务图派生
 *   member.ts       成员生命周期：任命、归档、恢复、释放
 *
 * 为什么用 `export *` 而不是逐条 `export { … }`：`tools/find-dead-exports.mjs`
 * 的判据是「符号名是否出现在别的文件里」，逐条列名会让这个入口把每个符号都
 * 「引用」一遍，死导出检测就永远为 0 —— 那是一道假绿的门禁。`export *` 不写出符号名，
 * 判定仍然落在真正的定义文件上。
 */
export * from './commands/project.ts'
export * from './commands/definitions.ts'
export * from './commands/team.ts'
export * from './commands/team-plan.ts'
export * from './commands/task.ts'
export * from './commands/member.ts'