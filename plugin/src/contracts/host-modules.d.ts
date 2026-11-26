/**
 * 宿主包的类型声明（本包**不依赖**它们，只在运行时动态解析）。
 *
 * 为什么需要这个文件：`composition/panel.ts` 与 `composition/human-card-kind.ts` 在
 * 运行时用 `await import('@deepseek-ai/dsh-typert-protocol')` / `await import('zod')`
 * 去宿主安装目录里找这两个包，找不到就**明确降级**（记 warning、不注册），而不是让
 * 整个 profile 起不来。这是刻意的设计：它们不是本包的依赖，装进 `dependencies` 会让
 * 插件与宿主版本绑死。
 *
 * 但 tsc 不知道这层运行时解析，会报 TS2307「找不到模块」。这里给它们一个**最小**声明：
 * 只声明代码实际用到的形状，不假装完整。这样类型门禁能通过，而「这两个包不在依赖里」
 * 这件事仍然由运行时 try/catch 负责——两件事互不掩盖。
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

declare module 'zod' {
  /** 本包只用到 `z.object` / `z.enum` / `z.string` 三个构造器（见 human-card-kind.ts）。 */
  export const z: {
    object(shape: Record<string, unknown>): unknown
    enum(values: readonly string[]): unknown
    string(): unknown
  }
}
