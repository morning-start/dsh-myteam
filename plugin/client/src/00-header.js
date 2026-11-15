/**
 * dsh-myteam client 插件（T13，M1 收窄版 CHG-16 第一刀 + 官方生命周期对齐修订）。
 *
 * 形态（与官方 dsh-experimental-client-ui-agent-team 同构，ui-plugin.md 契约）：
 *   window.__ModuleLoader__.load({ id, factory(require) }) — 懒 CJS 模块表消费；
 *   factory 返回 { apply, inject }：inject 声明必需的浏览器服务，apply(ctx) 注册资源，
 *   所有注册（locale 字典/样式/插槽）放进 ctx.effect —— 卸载即回收。
 *
 * 修订记录（对照官方 client 的三处结构缺陷）：
 *   ① apply 未导出 inject、未注册 locale 字典 → 补（visible text 走 locale service）；
 *   ② 样式在 factory 阶段注入（不可清理）→ 移入 ctx.effect；
 *   ③ Panel/DockChip 依赖的 ctx 经插槽 inject: () => ({ ctx }) 传入（原实现传 () => ({})
 *      导致组件拿到 undefined 一渲染即崩）。
 *
 * 纪律（NFR-7.2/F2）：面板只读服务投影，数据绝不进模型上下文；
 * 写只走 planAction/postComment/disband（ADR-006 面板唯一写入口 = 账本管线）。
 * 样式只用 --dsw-alias-* token（PRD 落点纪律），H4 三通道（文字+图标+形状）不依赖颜色。
 *
 * M2 RPC 通道（阶段四十七~四十九网关取证后定案）：宿主侧新增根级门面服务
 * MyTeamPanelFacade（src/panel.ts，namespace=myteam），方法首参 `agent` 由网关
 * lookup 解析成 Agent 实例（客户端传 sessionId）；隔离的 MyTeamRemote 经
 * agentPresets.serviceFor(agent,'myteam') 读取。客户端不走 $mount/生成描述符
 * （strip-only 无 codegen），直连网关 RPC：connection.rpc.call('/api','myteam/<method>',
 * { args: { agentId, query } })，返回 {ok,value}|{ok,error} 信封（官方 invokeRemote 同形）。
 * slot inject 回调首参 = binding.key = sessionId（dsh-client-ui-renderer runInject）；
 * root 槽（main）无 binding → Panel 先 listTeams 发现队长会话。
 */