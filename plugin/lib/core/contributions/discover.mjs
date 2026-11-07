/**
 * CHG-91（契约 §3 / §8.2）：贡献目录的**发现**。
 *
 * 只做一件事：把 `$DSH_HOME/myteam/plugins/` 下的子目录列出来。
 * **不解析任何 JSON**（解析在 `parse.ts`，纯函数），这样「目录长什么样」和
 * 「内容对不对」可以分别测——发现层的失败只有一种：根目录不存在。
 *
 * 安全：不跟随符号链接（`withFileTypes` + `isDirectory()` 对 symlink 返回 false），
 * 防越权读（契约 §3.3）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveMyteamHome } from '../index/team-index.mjs'
                                                       

/**
 * 贡献根目录：`$DSH_HOME/myteam/plugins`。
 *
 * 与既有路径同级（`$DSH_HOME/myteam/roles/` 全局角色库、`$DSH_HOME/myteam/workspaces.json` 全局索引），
 * 这样「插件贡献」在文件系统上就是 myteam home 下的一等公民，不是藏在某个工作区里。
 */
export function contributionsRoot(env                    = process.env)         {
  return join(resolveMyteamHome(env), 'plugins')
}

/**
 * 发现所有插件贡献目录（按目录名**字典序**排序 —— 冲突裁决的确定性依赖它，契约 §7.2）。
 *
 * @param root 贡献根目录（缺省 `contributionsRoot()`）
 * @returns 空数组 = 没有插件贡献（**正常态**，不是错误）
 */
export function discoverContributions(root         = contributionsRoot())                       {
  if (!existsSync(root)) return []
  let entries                                
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    // 根目录不可读（权限）：等同于「没有贡献」，但调用方应通过 warnings 知道（parse 层不感知）
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const dir = join(root, name)
      return { pluginId: name, dir, manifestPath: join(dir, 'plugin.json') }
    })
}

/**
 * 插件目录是否「看起来像」一个贡献（有 `plugin.json`）。
 *
 * 用来在面板里区分「这是给人看的根目录」和「这是插件」——不参与装载决策
 * （装载仍然「有清单就校验，没有就报 MANIFEST_INVALID」，因为静默跳过是 P4 禁止的）。
 */
export function looksLikeContribution(dir        )          {
  try {
    return existsSync(join(dir, 'plugin.json')) && statSync(dir).isDirectory()
  } catch {
    return false
  }
}


//# sourceURL=file:///E:/Workplace/extension/dsh-myteam/plugin/src/core/contributions/discover.ts