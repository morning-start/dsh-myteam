/**
 * 面板写方法白名单与确认协议。
 *
 * 这里回答三件事：**有哪些写方法**（PANEL_WRITE_METHODS）、**每个方法怎么确认**
 * （令牌 `token` 还是显式 `direct`）、以及**每个方法干什么**（PANEL_WRITE_DOCS，
 * 供 `tools/gen-panel-contract.mjs` 生成契约文档）。新增写能力必须同时在这里登记并补测试。
 * 由 {@link ../panel-writes.ts} 统一重导出。
 */
import { randomUUID } from 'node:crypto'
import type { ActorRef } from '../../contracts/events.ts'
import { HumanAuthorizer } from '../../domain/permissions/human-authorizer.ts'

/** 面板写方法白名单。新增写能力必须同时在这里登记并补测试。 */
export const PANEL_WRITE_METHODS = [
  'teamDisband',
  'captainTakeover',
  'gateVerdict',
  'taskCreate',
  'taskMove',
  'teamCreate',
  'memberAppoint',
  'memberRelease',
  'memberArchive',
  'memberRestore',
  'definitionPublish',
  'globalDefinitionSave',
  'globalUnpublish',
  'projectDestroy',
  'definitionSave',
  'memoryRemember',
  'memoryForget',
  'planPropose',
  'planDiscard',
  'planApprove',
] as const

export type PanelWriteMethod = (typeof PANEL_WRITE_METHODS)[number]

/**
 * 写方法的确认方式，决定请求怎么走：
 *
 * - `token`：先预览影响面拿一次性令牌，再凭令牌确认。用于 `HUMAN_ONLY` 动作——
 *   令牌把「你看到的影响面」和「真正执行的那次」绑死，中间状态变了就失败。
 * - `direct`：请求体带 `confirm: true` 直接执行。用于**不是人类专属**、但后果不可
 *   撤销的动作：它们在域里已有自己的前置校验（例如门禁裁决要求任务处于 `review`
 *   且 `attemptId` 是当前 Attempt），硬塞令牌只会造出一层没有信息的仪式。
 */
export type PanelWriteKind = 'token' | 'direct'

export const PANEL_WRITE_KINDS: Readonly<Record<PanelWriteMethod, PanelWriteKind>> = {
  teamDisband: 'token',
  captainTakeover: 'token',
  gateVerdict: 'direct',
  taskCreate: 'direct',
  taskMove: 'direct',
  teamCreate: 'direct',
  memberAppoint: 'direct',
  memberRelease: 'direct',
  memberArchive: 'direct',
  memberRestore: 'direct',
  definitionPublish: 'token',
  globalDefinitionSave: 'token',
  globalUnpublish: 'token',
  projectDestroy: 'token',
  definitionSave: 'direct',
  memoryRemember: 'direct',
  memoryForget: 'direct',
  // 提案与丢弃不改变任何实体（提案只落计划、丢弃零回滚），不需要令牌仪式。
  planPropose: 'direct',
  planDiscard: 'direct',
  // 批准会一次建出整个团队，是 HUMAN_ONLY —— 令牌把「看到的影响面」和「执行的那次」绑死。
  planApprove: 'token',
}

/** 判断一个名字是否为已登记的面板写方法。 */
export function isPanelWriteMethod(value: string): value is PanelWriteMethod {
  return (PANEL_WRITE_METHODS as readonly string[]).includes(value)
}

/** 写方法的确认方式。 */
export function panelWriteKind(method: PanelWriteMethod): PanelWriteKind {
  return PANEL_WRITE_KINDS[method]
}

/**
 * 按确认方式切分的写方法子集。
 *
 * 为什么需要：`previewPanelWrite` / `applyPanelWrite` 只处理 token 类，
 * `applyDirectPanelWrite` 只处理 direct 类。三者都用 `switch` + `const exhaustive: never`
 * 做穷尽性检查，但参数类型若写成整个 `PanelWriteMethod`，那个 `never` 永远不成立——
 * tsc 报 TS2322，strip 构建不报错，于是「漏了一个 case」这件事没人发现。
 */
export type TokenPanelWriteMethod = {
  [K in PanelWriteMethod]: (typeof PANEL_WRITE_KINDS)[K] extends 'token' ? K : never
}[PanelWriteMethod]
export type DirectPanelWriteMethod = {
  [K in PanelWriteMethod]: (typeof PANEL_WRITE_KINDS)[K] extends 'direct' ? K : never
}[PanelWriteMethod]

/**
 * 类型守卫：`name` 是不是 direct 类写方法。
 *
 * 为什么不用 `panelWriteKind(name) === 'direct'`：那是一次运行时比较，TS 不会据此
 * 收窄 `name` 的类型，调用方仍然要写 `as never` 才能过编译——而 `as never` 会把
 * 「传错方法」这件事彻底藏起来。类型谓词让收窄发生在类型层。
 */
export function isDirectPanelWrite(method: PanelWriteMethod): method is DirectPanelWriteMethod {
  return PANEL_WRITE_KINDS[method] === 'direct'
}

/** 类型守卫：`name` 是不是 token 类写方法。 */
export function isTokenPanelWrite(method: PanelWriteMethod): method is TokenPanelWriteMethod {
  return PANEL_WRITE_KINDS[method] === 'token'
}

/** 每个写方法的一句话说明；由 `tools/gen-panel-contract.mjs` 生成契约文档。 */
export const PANEL_WRITE_DOCS: Readonly<Record<PanelWriteMethod, string>> = {
  teamDisband: '解散团队：预览成员与任务影响面，凭一次性令牌执行。动作 `team.disband`（人类专属）。',
  captainTakeover: '队长接管：预览世代递增与生效成员，凭一次性令牌执行。动作 `captain.takeover`（人类专属）。',
  gateVerdict: '门禁裁决：对评审中的任务写入 pass / fail / blocked 与检查结果，需 `confirm: true`。',
  taskCreate: '新建任务：标题、验收标准、依赖与所需角色，建在指定团队下，需 `confirm: true`。',
  taskMove: '移动任务：只支持取消 / 重开 / 认领三个方向的合法迁移；完成必须走门禁裁决，需 `confirm: true`。',
  teamCreate: '建团队：名字、目标、队长会话（可选蓝图初始化角色与配置），需 `confirm: true`。',
  memberAppoint: '召唤成员：团队 + 角色（可选父成员与会话）→ 聘任并固化角色快照，需 `confirm: true`。',
  memberRelease: '释放成员（终态）：成员不能有进行中的尝试；释放后不再接活，需 `confirm: true`。',
  memberArchive: '归档成员（退役但可回放）：名册留痕、记忆与证据保留、可恢复；有进行中尝试时要么等结束（drain=wait），要么先暂停再归档（drain=pause）；子成员须先处理，需 `confirm: true`。',
  memberRestore: '恢复已归档成员（archived → active）；只对归档态有效，已释放不可恢复，需 `confirm: true`。',
  definitionSave: '保存项目定义（角色 / 工作流）：revision 递增并记 previousHash，需 `confirm: true`。',
  definitionPublish: '发布定义到全局库：预览引用与覆盖影响面，凭一次性令牌执行。动作 `definition.publish.confirm`（人类专属）。',
  globalDefinitionSave: '直改全局库里的定义（不经项目）：预览引用与被引用、冲突检测（expectedHash），凭一次性令牌执行。动作 `definition.global.write`（人类专属）。',
  globalUnpublish: '下架全局库里的定义：只从目录里隐藏，文件保留、引用方仍能读；冲突检测后凭一次性令牌执行。动作 `definition.global.write`（人类专属）。',
  projectDestroy: '删除项目数据（事件日志 / 记忆库 / 投影 / 租约），**不可撤销**：先预览逐项影响面，输入项目名后才能凭一次性令牌执行。动作 `project.destroy`（人类专属）。',
  memoryRemember: '写一条长期记忆到团队 bank 或某个成员 bank，需 `confirm: true`。',
  memoryForget: '遗忘一条记忆（默认软删留痕，`hard` 才真删），需 `confirm: true`。',
  planPropose: '提案开队计划：名字、目标、队长会话、队形与默认工作流，只落计划不建实体，需 `confirm: true`。',
  planDiscard: '丢弃待批准的计划：只落一条 `team.plan.discarded`，不产生任何会话与花费，需 `confirm: true`。',
  planApprove: '批准开队计划：预览影响面（几名成员、几个任务、开不开 Run），凭一次性令牌执行。动作 `plan.approve`（人类专属）。',
}

/** 面板动作的 actor：单属主部署下的人类入口。 */
export const PANEL_HUMAN: ActorRef = { kind: 'human', userId: 'owner', via: 'panel' }

/** 建一个令牌签发器（一次性 nonce、10 分钟有效）。 */
export function createPanelWriteAuthorizer(): HumanAuthorizer {
  return new HumanAuthorizer({
    now: () => new Date().toISOString(),
    createNonce: () => randomUUID(),
    ttlMs: 10 * 60_000,
  })
}
