/**
 * CHG-87（docs/04 §2 承诺的 `roleOp` 端点）：角色库写操作的统一入口。
 *
 * 为什么需要这一层：docs/04 §2 把 `roleOp(op, payload)` 写成对外端点（「角色 CRUD/fork/
 * 发布（FR-13.1，C7 守门在 host）」），实现却只有面板的 `saveRole` / `deleteRole` ——
 * **文档承诺与实现分叉**。同时 M2 的「发布到全局库」「fork 成新 id」也一直没有落点。
 *
 * 分层：本模块只做「角色库文件语义」（`RoleStorePaths` 进、结果对象出），
 *  - host 侧（`MyTeamHost.roleOp`）用插件配置解析出的角色库路径；
 *  - 面板侧（`MyTeamPanelFacade.roleOp`）用 `projectRolePaths(workspaceRoot)`，
 *    于是离线团队（没有活动会话）也能改角色库——角色是**配置资产**，不需要会话。
 * 两条路径共用同一份实现，不会出现「工具能改、面板改不了」这类分叉。
 *
 * C7 守门（占用面）由调用方算好传进来（`bindings`）：占用面的数据源是团队账本 +
 * 模板目录，属于上层域，不该让角色库模块去读账本。
 */
import { join } from 'node:path'
import {
  assertValidRole,
  deleteGlobalRoleSafe,
  deleteProjectRoleSafe,
  listRoleCatalog,
  readGlobalRole,
  readProjectRole,
  saveGlobalRole,
  saveProjectRole,
  writeProjectRole,
                      
                      
} from './role-store.mjs'
import { assertWritableAtScope, normalizeScope,            } from '../workspace/scope.mjs'

                                
                       
                                                     
                     
                           
                
 

                                                               

export const ROLE_OPS                        = ['save', 'delete', 'publish', 'fork']

/**
 * 角色库统一写入口。
 *
 * | op | 语义 | 作用域 | 两段确认 |
 * |----|------|--------|----------|
 * | `save` | 新建/覆盖角色（默认项目库） | `project`（缺省）\| `global`（须明示） | 同名已存在 → `confirm=true`；全局 → `confirmGlobal=true` |
 * | `delete` | 删除角色（C7 守门：占用面非空 → `MT_ROLE_OCCUPIED`） | 同上 | 恒需 `confirm=true`（全局另需 `confirmGlobal=true`） |
 * | `publish` | 项目库角色 → 全局库（对工作区所有项目可见） | 单向流动 | 恒需 `confirm=true` |
 * | `fork` | 任意来源角色复制成**新 id** 的项目库角色 | 项目 | 无（同名已存在 → `MT_ROLE_EXISTS`） |
 *
 * **作用域纪律（CHG-103，用户定案）**：全局是**必须明示**的——`scope` 缺省 = `project`。
 * 传 `global` 时还要 `confirmGlobal: true` 才落盘，否则返回 `confirm-required`
 * （模型必须先把「这会写进跨项目全局库」讲清楚、拿到用户确认，再重试）。
 *
 * 内置身份 `captain` 是名册「有且仅有一个队长」的锚点：publish / fork 的目标 id 都不允许是它。
 */
export function roleOp(ctx               , op        , payload                          = {})                          {
  const action = String(op ?? '')              
  const actor = ctx.actor ?? 'human'
  switch (action) {
    case 'save': {
      const role = payload.role
      if (!role || typeof role !== 'object' || Array.isArray(role)) {
        return { status: 'error', code: 'MT_VALIDATION', message: 'role is required (object)' }
      }
      try {
        // 先校验再谈覆盖：非法角色不该因为「同名已存在」而走到确认流程
        assertValidRole(role         )
        const def = role                             
        const scope = normalizeScope(payload.scope)
        // CHG-103：作用域守卫——角色两级都允许，但这条断言保证「全局只能放全局该放的东西」
        assertWritableAtScope(scope, 'roles')
        if (scope === 'global') {
          if (payload.confirmGlobal !== true) {
            return {
              status: 'confirm-required',
              scope: 'global',
              roleId: def.id,
              filePath: join(ctx.paths.globalRolesDir ?? '', `${def.id}.json`),
              message: `「${def.name || def.id}」将被写入**全局角色库**（对所有项目可见，不是只在本项目）。确认全局作用域请带 confirmGlobal=true 重试；只想本项目用请省略 scope（默认项目级）。`,
            }
          }
          const existingGlobal = readGlobalRole(ctx.paths, def.id)
          if (existingGlobal && payload.confirm !== true) {
            return {
              status: 'confirm-required',
              scope: 'global',
              existing: { id: existingGlobal.id, name: existingGlobal.name, version: existingGlobal.version ?? 1 },
              message: `全局角色 "${def.id}" 已存在，保存会覆盖该文件；确认请带 confirm=true`,
            }
          }
          const out = saveGlobalRole(ctx.paths, def, { overwrite: payload.confirm === true, actor })
          return { status: 'saved', scope: 'global', roleId: def.id, ...out }
        }
        const existing = readProjectRole(ctx.paths.projectRolesDir, def.id)
        if (existing && payload.confirm !== true) {
          return {
            status: 'confirm-required',
            scope: 'project',
            existing: { id: existing.id, name: existing.name, version: existing.version ?? 1 },
            message: `角色 "${def.id}" 已存在于项目库，保存会覆盖该文件（在跑实例仍用召唤时快照）；确认请带 confirm=true`,
          }
        }
        const out = saveProjectRole(ctx.paths, def, { overwrite: payload.confirm === true, actor })
        return { status: 'saved', scope: 'project', roleId: def.id, ...out }
      } catch (e) {
        return roleOpError(e)
      }
    }
    case 'delete': {
      const roleId = String(payload.roleId ?? '').trim()
      if (!roleId) return { status: 'error', code: 'MT_VALIDATION', message: 'roleId is required' }
      try {
        const scope = normalizeScope(payload.scope)
        assertWritableAtScope(scope, 'roles')
        if (scope === 'global') {
          if (payload.confirmGlobal !== true || payload.confirm !== true) {
            return {
              status: 'confirm-required',
              scope: 'global',
              roleId,
              bindings: [...(ctx.bindings ?? [])],
              message: `删除**全局**角色「${roleId}」会影响所有项目的可见性（各项目里的副本不受影响）；确认请同时带 confirmGlobal=true 与 confirm=true`,
            }
          }
          const out = deleteGlobalRoleSafe(ctx.paths, roleId, { bindings: ctx.bindings ?? [], actor })
          return { status: 'deleted', scope: 'global', roleId, ...out }
        }
        if (payload.confirm !== true) {
          return {
            status: 'confirm-required',
            scope: 'project',
            roleId,
            bindings: [...(ctx.bindings ?? [])],
            message: `删除项目角色「${roleId}」会移除 .dsh-myteam/config/roles/${roleId}.json（在跑成员仍用召唤时快照）；确认请带 confirm=true`,
          }
        }
        const out = deleteProjectRoleSafe(ctx.paths, roleId, { bindings: ctx.bindings ?? [], actor })
        return { status: 'deleted', scope: 'project', roleId, ...out }
      } catch (e) {
        return roleOpError(e)
      }
    }
    case 'publish': {
      const roleId = String(payload.roleId ?? '').trim()
      if (!roleId) return { status: 'error', code: 'MT_VALIDATION', message: 'roleId is required' }
      if (roleId === 'captain') {
        return { status: 'error', code: 'MT_ROLE_CAPTAIN', message: 'captain is a builtin identity; it cannot be published to the global library' }
      }
      if (!ctx.paths.globalRolesDir) {
        return { status: 'error', code: 'MT_ROLE_NO_GLOBAL_DIR', message: 'global roles dir is not configured; cannot publish' }
      }
      const def = readProjectRole(ctx.paths.projectRolesDir, roleId)
      if (!def) {
        return {
          status: 'error',
          code: 'MT_ROLE_NOT_FOUND',
          message: `role "${roleId}" not found in project library; 只能发布项目库里的角色（内置/全局是复制源，不是发布源）`,
        }
      }
      if (payload.confirm !== true) {
        return {
          status: 'confirm-required',
          roleId,
          impact: { scope: 'global', workspaces: 'all', filePath: join(ctx.paths.globalRolesDir, `${roleId}.json`) },
          message: `把「${def.name}」发布到全局角色库？全局库对该工作区**所有项目**可见（单向流动：发布后各项目仍需显式 copyToProject 才生效）。带 confirm=true 落盘`,
        }
      }
      try {
        const written = writeProjectRole(ctx.paths.globalRolesDir, structuredClone(def))
        return {
          status: 'published',
          roleId,
          filePath: written.filePath,
          note: '已发布到全局角色库；其它项目可在角色目录看到它（origin=global），copyToProject 后才进各自项目库',
        }
      } catch (e) {
        return roleOpError(e)
      }
    }
    case 'fork': {
      const fromRoleId = String(payload.fromRoleId ?? '').trim()
      const toRoleId = String(payload.toRoleId ?? '').trim()
      if (!fromRoleId || !toRoleId) {
        return { status: 'error', code: 'MT_VALIDATION', message: 'fork requires fromRoleId and toRoleId' }
      }
      if (toRoleId === 'captain') {
        return { status: 'error', code: 'MT_ROLE_CAPTAIN', message: 'captain is a builtin identity; fork to another id' }
      }
      const source = listRoleCatalog(ctx.paths).find((entry) => entry.definition.id === fromRoleId)
      if (!source) return { status: 'error', code: 'MT_ROLE_NOT_FOUND', message: `role "${fromRoleId}" not found in any library` }
      if (readProjectRole(ctx.paths.projectRolesDir, toRoleId)) {
        return { status: 'error', code: 'MT_ROLE_EXISTS', message: `project role "${toRoleId}" already exists; fork refused (no silent overwrite)` }
      }
      const copy                 = {
        ...structuredClone(source.definition),
        id: toRoleId,
        name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : `${source.definition.name} 副本`,
        version: 1,
        ...(source.origin === 'builtin' ? { origin: `builtin:${fromRoleId}` } : {}),
      }
      try {
        const written = writeProjectRole(ctx.paths.projectRolesDir, copy)
        return {
          status: 'forked',
          roleId: toRoleId,
          fromRoleId,
          filePath: written.filePath,
          note: '已复制进项目库（origin 保留来源）；改它不影响来源角色',
        }
      } catch (e) {
        return roleOpError(e)
      }
    }
    default:
      return { status: 'error', code: 'MT_VALIDATION', message: `unknown roleOp: ${action || '(empty)'}（${ROLE_OPS.join(' | ')}）` }
  }
}

function roleOpError(e         )                          {
  const err = e                                       
  return { status: 'error', code: err.code ?? 'MT_ROLE_INVALID', message: err.message ?? String(e) }
}


//# sourceURL=./src/core/roles/role-ops.ts