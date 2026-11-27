/**
 * 面板写通道：白名单 → 预览签发令牌 → 凭令牌执行。
 *
 * 面板 RPC 不直接调命令层，必须过这里，于是「哪些动作能写、怎么确认、留什么审计」
 * 只有一份答案。面板、工具面与测试都从本入口取。
 *
 * ── 本文件是聚合入口，不是实现 ────────────────────────────────────────────────
 * 实现按阶段拆在 `panel-writes/` 下（每个文件的头注释说明它管哪一步），这里只做重导出，
 * 保证历史上 `./panel-writes.ts` 的导入面一个字都不用改：
 *
 *   methods.ts    写方法白名单、确认方式、每方法说明、人类 actor 与令牌签发器
 *   params.ts     入参收窄（unknown → 领域类型），预览与执行共用
 *   deps.ts       外部端口形状（销毁 / 全局库 / 发布 / 记忆）与取用器
 *   previews.ts   第一步：算影响面并签发一次性令牌
 *   apply.ts      第二步：凭令牌执行；direct 类由显式 confirm 执行
 *
 * 为什么用 `export *` 而不是逐条 `export { … }`：`tools/find-dead-exports.mjs`
 * 的判据是「符号名是否出现在别的文件里」，逐条列名会让这个入口把每个符号都
 * 「引用」一遍，死导出检测就永远为 0 —— 那是一道假绿的门禁。
 */
export * from './panel-writes/methods.ts'
export * from './panel-writes/params.ts'
export * from './panel-writes/deps.ts'
export * from './panel-writes/previews.ts'
export * from './panel-writes/apply.ts'