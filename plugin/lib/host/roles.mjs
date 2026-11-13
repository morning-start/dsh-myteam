/**
 * CHG-186（T155c）：角色族端点适配层。
 *
 * 纪律：这里只做「参数整形 + 调宿主 + 返回」，**不放业务规则**——规则在
 * `core/roles/**`（`role-store.ts` 的落盘原语、`role-ops.ts` 的面板共用实现），
 * 装配与状态在 `host.ts`。方法体**逐字搬自** `host.ts` 的 `switch (toolName)` 里对应
 * case，允许的差异只有：
 *   ① `this.` → `host.`（宿主面，见下）；
 *   ② `this.rolePaths` → `host.rolePaths()`（私有 **getter**，不能在装配处取值快照）；
 *   ③ 未使用的通道参数标 `_` 前缀（`set_project_role` 只写项目自身角色，不碰团队账本，
 *      所以 `teamId` / `actor` 在这条分支里不参与计算——**不是**忘了接）。
 * 逻辑、顺序、默认值一个都不许改——这一批是纯结构重构，行为零变化。
 *
 * ── 为什么参数是「宿主面」而不是 `MyTeamHost` ────────────────────────────────────
 * 这些 case 依赖 `deleteRoleTool` / `roleError` 等 `MyTeamHost` 的**私有**成员，而 TS 的
 * 私有成员不参与结构化赋值（`private x` 满足不了接口里的 `x`）。两条路：把私有方法改成
 * public（扩大入口层 API，和「入口层只留装配」的方向相反），或者 `as` 强转（改名后编译器
 * 抓不到）。这里选第三条：host.ts 传一个**只含用到的成员**的闭包对象进来——私有方法名
 * 一改，装配处立刻编译报错。
 *
 * ── 为什么不是 async ───────────────────────────────────────────────────────────
 * 这七个端点原 case 全是**同步返回**（`executeLeadTool` 的返回类型是
 * `Record | Promise<Record>`）。加 `async` 会让原本同步的结果变成 Promise——调用方
 * （`test/`、面板远程面）就地拿到 `[object Promise]`。所以保持同步：搬实现不搬异步语义。
 */
                                                                 
import { clearProjectRoleCard, listRoleCatalog, writeProjectRoleCard } from '../core/roles/role-store.mjs'

/**
 * 角色族用到的宿主面（**只列用到的成员**，不做全能门面）。
 *
 * 口径：`grep "this\." host.ts` 里 `create_role` / `update_role` / `delete_role` /
 * `publish_role` / `copy_role` / `apply_roles` / `set_project_role` 七个 case 实际碰到的
 * 成员。加成员前先问：这条逻辑能不能落在 `core/roles/**`（那才是规则该在的地方）。
 */
                                   
                                                       
                             

                                                      
                                                   

                                                
                                                

                                                
                                                                           

                             
                                                                         

                          
                                                                      

                        
                                                                    

                                
                                                                    

                                                                      
                                                                                                   
 

export function createRolesHandlers(host                  ) {
  return {
    deleteRole(args                         )                          {
      return host.deleteRoleTool(String(args.roleId ?? ''), args.confirm === true)
    },

    setProjectRole(_teamId        , args                         , _actor        )                          {
      if (args.clear === true) {
        if (args.confirm !== true) return { status: 'confirm-required', message: '取消项目自身角色是两段确认操作，请带 confirm=true 重调' }
        clearProjectRoleCard(host.rolePaths())
        return { status: 'cleared', note: '项目自身角色已取消（不影响任何团队）' }
      }
      const roleId = String(args.roleId ?? '')
      const entry = host.roleCatalog().find((item) => item.definition.id === roleId)
      if (!entry) return { status: 'error', code: 'MT_ROLE_NOT_FOUND', message: `role "${roleId}" not found in any library` }
      if (args.confirm !== true) {
        return {
          status: 'confirm-required',
          role: { id: entry.definition.id, name: entry.definition.name, origin: entry.origin },
          message: `把「${entry.definition.name}」设为项目自身角色？它不属于任何团队，可被本项目各团队聘任。带 confirm=true 落盘`,
        }
      }
      try {
        const written = writeProjectRoleCard(host.rolePaths(), structuredClone(entry.definition))
        return {
          status: 'set',
          roleId,
          filePath: written.filePath,
          note: '项目自身角色已写入 config/project-role.json；团队组队时可直接聘任该角色',
        }
      } catch (e) {
        return host.roleError(e)
      }
    },

    publishRole(args                         )                          {
      return host.publishRoleTool(args)
    },

    copyRole(args                         )                          {
      return host.copyRoleTool(args)
    },

    createRole(args                         )                          {
      return host.createRole(args)
    },

    updateRole(args                         )                          {
      return host.updateRole(args)
    },

    applyRoles(teamId        , args                         , actor        )                          {
      // CHG-87（FR-16.1）：单角色调用——只写 config/roles/session-defaults.json，不碰团队账本
      return host.applyRoles(teamId, args, actor)
    },
  }
}


//# sourceURL=./src/host/roles.ts