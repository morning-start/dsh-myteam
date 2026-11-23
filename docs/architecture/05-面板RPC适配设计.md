# 面板 RPC 适配（已接通）

> 状态：**已完成**（2026-11-23 复核）。门面 `src/composition/panel.ts` + 客户端会话「团队视图」在隔离实例真机跑通：
> 16 个只读方法全部返回真数据，写动作走 `/__myteam/write/<method>`（见
> [contracts/panel-rpc](../contracts/panel-rpc.md) 与 [25-隔离验收记录](../delivery/25-隔离验收记录.md)）。
> 历史背景：把这套 `PanelService` 挂到 DSH 的 Remote 上，让 Web 客户端能 `ctx.remote.myteam.*` 调用。

## 已具备

| 件 | 位置 | 说明 |
|---|---|---|
| 只读契约 | `src/application/panel-contract.ts` | 7 个方法：status/overview/board/task/team/definitions/migration |
| 服务 | `src/application/panel-service.ts` | `invoke(rootDir, request)`，纯函数式，已被 `t14` 覆盖 |
| 会话→根 | `src/application/session-root.ts` | 只认绝对路径；相对/缺失返回 null（未绑定工作区） |
| 网关 | `src/application/panel-gateway.ts` | 会话未绑定 → `FORBIDDEN`，且不触碰项目数据 |
| 客户端 | `client/panel-client.js` | 与传输无关，已测 |

缺的只有**宿主绑定**：一个根级 `TypertRemoteService` 门面 + patch 行。

## 为什么必须是「根级门面」

v1 的实现（`plugin/src/panel.ts`，1458 行）已经踩过这条坑，结论可直接复用：

- 队长 preset 里的服务会被要求 `isolate`（entry-local realm）；
- 网关的 `claimsEndpoint` 只扫 **root 可见**服务，isolated 服务进不了 claims，
  客户端 `ctx.remote.myteam.*` 会被拒；
- 官方解法：在 **root 层**放一个门面服务，方法首参命名为 `agent`，
  由网关的 `agent` lookup 把 sessionId 解析成 Agent，门面再按会话解析工作区。

## 门面骨架

```ts
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

class MyTeamPanelFacade extends TypertRemoteService {
  constructor(ctx: unknown) {
    super(ctx as never, 'myteamPanel', { namespace: 'myteam' })
  }
  async status(agent: { id: string }, query: unknown) { return this.dispatch(agent.id, { method: 'status' }) }
  async board(agent: { id: string }, query: unknown) { return this.dispatch(agent.id, { method: 'board' }) }
  // …其余 5 个同形
}

// strip-only 环境没有装饰器：手动打 marker（与 v1 remote/service.ts 同形）
Object.defineProperty(MyTeamPanelFacade.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze(
      ['status','overview','board','task','team','definitions','migration']
        .map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) })),
    ),
  }),
})

export function apply(ctx: unknown): void {
  new MyTeamPanelFacade(ctx)
}
export const inject = ['agents', 'workingDirectory']
export default apply
```

`dispatch` 内部：

```ts
const service = new PanelService(hosts)          // 复用 ProjectHosts（进程级共享）
const root = await this.rootFor(agentId)          // workingDirectory.ensure(agent)
return createPanelGateway({ service, rootForSession: () => root }).invoke(agentId, request)
```

## patch 行（恢复 v1 的 carrier + panel 两行）

```yaml
- insert:
    - id: myteam-carrier
      name: 'dsh-plugin-myteam'      # 裸包名行：客户端模块图只认不带 / 的包名
      config: { carrier: true }
    - id: myteam-panel
      name: 'dsh-plugin-myteam/panel'
      inject: ['agents', 'workingDirectory']
```

> **前提**：`package.json` 的 `exports` 要加 `"./panel": "./lib/composition/panel.mjs"`，
> 并且这次**必须同时提供 client bundle**——v2 目前没有 `dsh.client` 段，
> 裸包名行会让前端整体起不来（本轮已修复过一次）。

## 验证计划

1. 构建后 `dsh --profile myteam-v2-web --port 0 --no-open` 启动，页面正常；
2. 客户端侧（下一步）：`client/panel-client.js` 接一个 `ctx.remote.myteam` 传输，
   在 Web 里渲染看板；
3. 失败时优先看：门面是否 root 可见、方法首参是否叫 `agent`、marker 是否打在原型上。

## 已知风险

- 客户端 bundle 缺失会让整个 Web 前端不可用（不是局部降级）——所以 RPC 与 client
  必须一起上，不能只加 patch 行；
- `TypertRemoteService` 需作为依赖声明，否则打包时会缺；
- 面板只读，本轮不做写操作，避免与 `commands/actionCards` 的授权模型混在一起。