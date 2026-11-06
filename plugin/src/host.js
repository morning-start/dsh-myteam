/**
 * dsh-plugin-myteam — host 薄转发层（遗留兼容入口）。
 *
 * 完整实现在 src/host.ts（apply/inject 官方形态）；本文件仅为兼容
 * test/t1-workplace.test.js 的历史 import 路径保留：re-export
 * host-workspace.ts 的纯函数域，自身不含逻辑（T7 收口后单一实现原则）。
 */
export { WORKPLACE_DIRS, ensureWorkplaceDirs, ensureGitignoreManagedBlock } from './host-workspace.ts'
