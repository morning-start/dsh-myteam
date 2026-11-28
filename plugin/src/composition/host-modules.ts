/**
 * 宿主包的**运行时解析器**（本包不依赖它们，只在运行时动态解析）。
 *
 * 为什么需要这个文件：DSH 的装载闭包只保证解析 `@deepseek-ai/*` 的一部分，
 * 而宿主包（`dsh-llm` / `dsh-typert-protocol` / `zod`）**不一定是闭包的一部分**
 * ——它们可能只存在于宿主安装目录（`DSH_INSTALL_DIR` 的兄弟目录）。
 * 于是「裸包名 import」在闭包里解析不到，而在本地开发机上又常常「恰好能解析」，
 * 换到干净 profile 就炸（toolkit 的错误卡片 `bare-name-dependency` 记的就是这个坑）。
 *
 * 所以这里统一走**既有模式**（原 `composition/panel.ts` 的 `loadProtocol()`，CHG-217 收拢到一处）：
 *   1. 先试**静态** import（闭包里有就用，官方形态）；
 *   2. 失败再从 `DSH_INSTALL_DIR` 用 `createRequire` 解析宿主安装目录里的那份。
 *
 * ⚠️ 第 1 步为什么必须是**静态**说明符：装载器对 `@deepseek-ai/*` 的解析走 ESM
 * 钩子，写成 `import(某个变量)` 虽然也走钩子，但让钩子失去了「这是哪个包」的信息，
 * 兜底率不可控。静态写法是宿主自己的包通用的形态（实测宿主包都这么 import）。
 *
 * ⚠️ `zod` **没有**第 1 步：它不是 `@deepseek-ai/*`，闭包里解析不到，
 * 裸名 import 只会「本地恰好能解析」。所以它只走第 2 步。
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 从宿主安装目录（`DSH_INSTALL_DIR`）解析一个包。
 *
 * @param specifier 包名，如 `@deepseek-ai/dsh-llm` / `zod`
 * @returns 解析到的模块 URL；宿主目录没设或包里没有这个包时返回 `undefined`
 */
async function resolveFromHostInstallDir(specifier: string): Promise<string | undefined> {
  const installDir = process.env.DSH_INSTALL_DIR
  if (installDir === undefined || installDir.length === 0) return undefined
  try {
    const requireFromHost = createRequire(join(installDir, 'package.json'))
    return pathToFileURL(requireFromHost.resolve(specifier)).href
  } catch {
    return undefined
  }
}

/**
 * 解析一个宿主安装目录里的包（**不**试裸包名）。
 *
 * @param specifier 包名
 * @returns 模块；解析不到时返回 `undefined`
 */
async function loadFromHostInstallDir(specifier: string): Promise<unknown> {
  const url = await resolveFromHostInstallDir(specifier)
  if (url === undefined) return undefined
  try {
    return await import(url)
  } catch {
    return undefined
  }
}

/**
 * `dsh-llm` 里本包用到的构造器集合。
 *
 * 只声明实际用到的字段——不假装完整，也不把本包与宿主版本绑死。
 */
export interface HostLlmModule {
  createUserMessage(input: {
    content: unknown[]
    source: { readonly kind: string; readonly [key: string]: unknown }
  }): HostUserMessage
}

/**
 * `dsh-llm` 的 `createUserMessage`：造一条**带 id 与 source** 的用户消息。
 *
 * `role` 声明成 `string` 而不是 `'user'` 字面量：本模块把这条消息原样交给
 * `followup`，从不按 role 收窄，声明最小形状就够。顺带避开一类**扫描器误报**——
 * `dsh_plugin_check` 的 `session:message-identity` 是**逐行**扫的：它取 `role:` 所在
 * 那一行里 `{` 到 `}` 的片段找 `id:`，于是**类型字段**（这一行本来就没有花括号）
 * 会被当成运行时消息字面量。装配层自己的规则（`tools/checks/rules.js`）有花括号
 * 保护、不会误报，但没必要为一行类型声明留一条会被反复看见的告警。
 *
 * ⚠️ 这只是形状声明；**真正的约束**是：交给会话的消息必须有非空 `id`。
 * 证据见 `test/t70-dispatch-message-shape.test.ts` 与宿主的 `adoptSessionEvent`。
 */
export interface HostUserMessage {
  readonly id: string
  /** 运行时固定是 `'user'`（宿主 `createUserMessage` 的语义）；这里只声明形状。 */
  readonly role: string
  readonly content: unknown[]
  readonly source: { readonly kind: string; readonly [key: string]: unknown }
}

/**
 * 解析 `@deepseek-ai/dsh-llm`。
 *
 * ⚠️ 刻意**不导出**：只有同文件的 `createAgentDispatchMessage` 用它。
 * 死导出棘轮（tools/check-all.mjs）会把「导出去但外部零引用」判为新增死导出——
 * 那是对的：这个解析器不是公开面。
 *
 * @returns 模块；宿主没带这个包时返回 `undefined`
 */
async function loadHostLlm(): Promise<HostLlmModule | undefined> {
  try {
    return (await import('@deepseek-ai/dsh-llm')) as HostLlmModule
  } catch {
    // 落到宿主安装目录
  }
  const module = await loadFromHostInstallDir('@deepseek-ai/dsh-llm')
  return module === undefined ? undefined : (module as HostLlmModule)
}

/**
 * 造一条**队长投给成员**的消息。
 *
 * ⚠️ 为什么必须有 id 与 source（CHG-217 P0-A）：手写字面量
 * `{ role:'user', content }` 写进会话时**不报错**（`session.append` 只校验 JSON
 * 可序列化），但持久化层在**用户下次打开会话时**校验 `message.id` 与
 * `message.source.kind`，缺一就抛 `lacks an identified message`，整段会话打不开。
 *
 * source 用 `agent-message` 而不是 `user`：这条消息是**队长投给成员**的任务说明，
 * 不是真人输入。标成 `user` 会让 `dsh-tool-goal` 的「直接人类授权」判定
 * （`hasDirectHumanInput`）把它当成真人输入，给模型它本不该有的授权。
 * 宿主的 `dsh-subagent` 给「Agent 之间的消息」用的就是这个 source 形状。
 *
 * **两条路都产出合规消息**（都用宿主自己的持久化校验器验过）：
 *   ① 宿主构造器 `createUserMessage` —— 首选，语义与宿主完全一致；
 *   ② 自己造 —— 宿主包解析不到时的兜底。宿主构造器内部只做三件事：
 *      `deepFreeze(structuredClone({...input, id: brandString(randomUUID())}))`。
 *      而 `brandString` 在运行时**是恒等函数**（实测 `dsh-brand` 的实现就是
 *      `return value`），所以「自己造 + `randomUUID()`」与宿主造出来的消息
 *      在持久化校验眼里**完全等价**（实测 `adoptSessionEvent` 两者都通过）。
 *
 * @param content 消息内容块
 * @param senderSessionId 发送方（队长）会话 id，写进 source 做归属
 */
export async function createAgentDispatchMessage(
  content: unknown[],
  senderSessionId: string,
): Promise<HostUserMessage> {
  const source = { kind: 'agent-message', form: 'relay', senderSessionId }
  const llm = await loadHostLlm()
  if (llm !== undefined) {
    try {
      return llm.createUserMessage({ content, source })
    } catch {
      // 落到兜底
    }
  }
  // 兜底与宿主构造器**等价**：宿主 createMessage 做的是
  // `deepFreeze(structuredClone({...input, id: brandString(randomUUID())}))`，
  // 而 `brandString` 运行时是恒等函数（实测 dsh-brand 的实现就是 `return value`），
  // 所以「自己造 + randomUUID()」与宿主造出来的消息在持久化校验眼里完全一样
  // （实测 adoptSessionEvent 两者都通过）。
  //
  // 写在一行里：`id` 与 `role` 必须落在同一行，否则逐行扫「消息字面量有没有 id」
  // 的扫描器（dsh_plugin_check 的 session:message-identity）会把这条合规消息报成缺陷。
  return { id: randomUUID(), role: 'user', content, source }
}

/**
 * 解析宿主安装目录里的 `zod`。
 *
 * ⚠️ **不**试裸包名：`zod` 不在装载闭包里，裸名 import 只会在「本地恰好装了同名
 * node_modules」的机器上成功。解析不到就返回 `undefined`，由调用方明确降级。
 *
 * @returns 模块；宿主没带 zod 时返回 `undefined`
 */
export async function loadHostZod(): Promise<unknown | undefined> {
  return loadFromHostInstallDir('zod')
}

/**
 * 解析 `@deepseek-ai/dsh-typert-protocol`（面板 RPC 的基类）。
 *
 * @returns 模块；宿主没带这个包时返回 `undefined`
 */
export async function loadHostProtocol(): Promise<unknown | undefined> {
  try {
    return await import('@deepseek-ai/dsh-typert-protocol')
  } catch {
    // 落到宿主安装目录
  }
  return loadFromHostInstallDir('@deepseek-ai/dsh-typert-protocol')
}
