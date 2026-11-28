/**
 * 宿主包的类型声明（本包**不依赖**它们，只在运行时动态解析）。
 *
 * 为什么需要这个文件：`composition/panel.ts` 与 `composition/human-card-kind.ts` 在
 * 运行时用 `await import('@deepseek-ai/dsh-typert-protocol')` / 宿主安装目录里的
 * `zod` 去解析这两个包，找不到就**明确降级**（记 warning、不注册），而不是让
 * 整个 profile 起不来。这是刻意的设计：它们不是本包的依赖，装进 `dependencies` 会让
 * 插件与宿主版本绑死。
 *
 * CHG-217：`zod` 的声明删掉了——裸名 `zod` 在装载闭包里解析不到，插件改走
 * `composition/host-modules.ts` 的宿主安装目录解析（不再有裸名 import，
 * 所以也不需要 `declare module 'zod'`）。新增的是 `@deepseek-ai/dsh-llm`：
 * 成员投递要用它造**带 id 与 source** 的消息（CHG-217 P0-A）。
 *
 * 但 tsc 不知道这层运行时解析，会报 TS2307「找不到模块」。这里给它们一个**最小**声明：
 * 只声明代码实际用到的形状，不假装完整。这样类型门禁能通过，而「这些包不在依赖里」
 * 这件事仍然由运行时的解析与降级负责——两件事互不掩盖。
 *
 * ⚠️ 新增对宿主包的使用时，要同步补这里的声明，否则 tsc 会报错（这是有意的：
 * 声明缺失 = 有人在用没被类型化的宿主能力）。
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  /** 宿主 typert 远程服务的基类；本包只 `extends` 它并挂自己的方法。 */
  export class TypertRemoteService {
    constructor(ctx: unknown, key: string, options: { namespace: string })
  }
}

declare module '@deepseek-ai/dsh-llm' {
  /**
   * 造一条**带 id 与 source** 的用户消息。
   *
   * 本包只用这一个构造器（见 composition/host.ts 的成员投递）。
   * 宿主会补上 `id`（`randomUUID`）并冻结消息——这两件事都是**必须的**：
   * 手写字面量写进会话时不报错，但持久化层在用户下次打开会话时校验
   * `message.id` 与 `message.source.kind`，缺一整段会话打不开。
   */
  export function createUserMessage(input: {
    content: unknown[]
    source: { kind: string; [key: string]: unknown }
  }): {
    readonly id: string
    /** 运行时固定是 `'user'`；最小形状声明用 `string`，理由见 composition/host-modules.ts。 */
    readonly role: string
    readonly content: unknown[]
    readonly source: { readonly kind: string; readonly [key: string]: unknown }
  }
}
