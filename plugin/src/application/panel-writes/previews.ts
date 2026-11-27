/**
 * 预览（第一步）：算清一次写动作会造成什么影响，并签发一次性确认令牌。
 *
 * 预览只读、不改账本；影响面按写方法分别算（销毁列条目、全局直改算引用、下架说明
 * 隐藏而非删除）。令牌里只留 hash，正文不落盘。由 {@link ../panel-writes.ts} 统一重导出。
 */
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import { HumanAuthorizer } from '../../domain/permissions/human-authorizer.ts'
import { previewTeamPlanApproval, previewCaptainTakeover, previewTeamDisband } from '../human-actions.ts'
import { requestDefinitionPublication } from '../publication.ts'
import { requireDestroyer, requireGlobalEditor, requireGlobalEntries, requirePublicationKind, requirePublisher } from './deps.ts'
import { PANEL_HUMAN } from './methods.ts'
import { requireRootDir, requireString, requireTeamId } from './params.ts'
import type { PublicationKind } from '../../contracts/publication.ts'
import type { ProjectRuntime } from '../project-runtime.ts'
import type { PanelWriteDeps, PanelWritePreview } from './deps.ts'
import type { PanelWriteMethod } from './methods.ts'

/** 销毁预览：逐项列出要删的东西与不可逆后果。 */
export function previewProjectDestroy(
  deps: PanelWriteDeps,
  rootDir: string,
): { operationId: string; targetHash: string; impactHash: string; summary: string; impact: unknown } {
  const destroyer = requireDestroyer(deps)
  const preview = destroyer.preview(rootDir)
  const impact = {
    target: rootDir,
    name: preview.name,
    projectId: preview.projectId,
    targets: preview.targets,
    totalBytes: preview.totalBytes,
    irreversible: preview.irreversible,
  }
  const operationId = 'project-destroy-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  return {
    operationId,
    // targetHash 绑「要删的这个项目」：项目名 + projectId + 总字节数。
    // 目标变了（比如删之前又写了一堆事件）就拒，避免「看的是 12 KB、删的是 40 MB」。
    targetHash: stableHash({ name: preview.name, projectId: preview.projectId, bytes: preview.totalBytes }),
    impactHash: stableHash(impact),
    summary: '删除项目「' + preview.name + '」的全部数据（' + String(preview.targets.length) + ' 项 · ' +
      String(Math.round(preview.totalBytes / 1024)) + ' KB）：不可撤销',
    impact,
  }
}

/**
 * 全局直改的预览（令牌第一步）。
 *
 * 影响面只有两件事：**引用谁**（这份定义引用的全局角色/工作流，会不会有缺的）与
 * **被谁引用**（别的全局蓝图/工作流指着它，改完它们会「有更新」）。后者现在只能给数量，
 * 因为全局目录读取器按 kind 列条目时还没有反查索引 —— 这里如实写「N 条同名引用」而不是编一张清单。
 */
export function previewGlobalEdit(
  deps: PanelWriteDeps,
  input: { kind: PublicationKind; id: string; definition: unknown },
): { operationId: string; targetHash: string; impactHash: string; summary: string; impact: unknown } {
  const editor = requireGlobalEditor(deps)
  const entries = requireGlobalEntries(deps)
  if (input.definition === undefined) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '缺少参数 definition')
  }
  const actualHash = editor.readFileHash(input.kind, input.id)
  const targetHash = actualHash === null ? 'sha256:absent' : actualHash

  const asRecord = input.definition as Record<string, unknown>
  const formation = Array.isArray(asRecord.formation) ? (asRecord.formation as Array<{ roleId?: string }>) : []
  const templates = Array.isArray(asRecord.templates) ? (asRecord.templates as Array<{ requiredRoleId?: string | null }>) : []
  const workflows = Array.isArray(asRecord.workflows) ? (asRecord.workflows as string[]) : []
  const roleIds = [
    ...formation.map((slot) => slot.roleId).filter((roleId): roleId is string => typeof roleId === 'string'),
    ...templates.map((template) => template.requiredRoleId).filter((roleId): roleId is string => typeof roleId === 'string'),
  ]
  const globalRoleIds = new Set(entries.list('role').map((entry) => entry.id))
  const globalWorkflowIds = new Set(entries.list('workflow').map((entry) => entry.id))
  const missingReferences = [
    ...roleIds.filter((roleId) => !globalRoleIds.has(roleId)).map((roleId) => 'role:' + roleId),
    ...workflows.filter((workflowId) => !globalWorkflowIds.has(workflowId)).map((workflowId) => 'workflow:' + workflowId),
  ]
  const impact = {
    target: input.kind + '/' + input.id,
    createsFile: actualHash === null,
    overwrites: actualHash !== null,
    missingReferences,
    irreversible: [
      actualHash === null ? '全局库会多出一份定义' : '会覆盖全局库里的同名定义，旧内容不保留（审计里留 previousHash）',
      '改的是全局库文件，所有引用它的项目/团队下次读到新版本',
    ],
  }
  const operationId = 'global-edit-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  return {
    operationId,
    targetHash,
    impactHash: stableHash(impact),
    summary:
      (actualHash === null ? '新建' : '修改') + '全局' + input.kind + '「' + input.id + '」' +
      (missingReferences.length > 0 ? '：' + String(missingReferences.length) + ' 处引用在全局库里找不到' : '：引用都能解析'),
    impact,
  }
}

/** 影响面的稳定 hash：字段顺序固定，便于「同一影响面换同一令牌」。 */
function stableHash(value: unknown): string {
  const text = JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort())
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return 'impact:' + (hash >>> 0).toString(16)
}

/** 下架的预览：说清「会被从目录里隐藏」与「文件与引用不受影响」。 */
export function previewGlobalUnpublish(
  deps: PanelWriteDeps,
  input: { kind: PublicationKind; id: string },
): { operationId: string; targetHash: string; impactHash: string; summary: string; impact: unknown } {
  const editor = requireGlobalEditor(deps)
  const actual = editor.readFileHash(input.kind, input.id)
  if (actual === null) {
    fail(ERROR_CODES.NOT_FOUND, '全局库里没有这份定义', { details: { kind: input.kind, id: input.id } })
  }
  const impact = {
    target: input.kind + '/' + input.id,
    hidesFromCatalog: true,
    deletesFile: false,
    reversible: true,
    irreversible: [
      '目录里不再出现这份定义（新建团队/复制时选不到）',
      '文件与审计都保留；已经引用它的工作流、蓝图、团队照常能读到这一版',
    ],
  }
  const operationId = 'global-unpub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  return {
    operationId,
    targetHash: actual,
    impactHash: stableHash(impact),
    summary: '下架全局' + input.kind + '「' + input.id + '」：只从目录隐藏，引用方不受影响',
    impact,
  }
}

/**
 * 第一步：预览影响面并签发确认令牌。
 * @param runtime - 项目运行时（已打开）。
 * @param authorizer - 令牌签发器（与确认共用同一实例）。
 * @param method - 白名单方法名。
 * @param params - 方法参数。
 * @param deps - 额外端口（全局发布用）。
 */
export function previewPanelWrite(
  runtime: ProjectRuntime,
  authorizer: HumanAuthorizer,
  method: PanelWriteMethod,
  params: Record<string, unknown>,
  deps: PanelWriteDeps = {},
): PanelWritePreview {
  switch (method) {
    case 'globalDefinitionSave': {
      const preview = previewGlobalEdit(deps, {
        kind: requirePublicationKind(params),
        id: requireString(params, 'id'),
        definition: params.definition,
      })
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'definition.global.write',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    case 'projectDestroy': {
      // 项目数据销毁：两步式。第一步出影响面并签令牌，不删任何东西。
      const preview = previewProjectDestroy(deps, requireRootDir(deps))
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'project.destroy',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    case 'globalUnpublish': {
      const preview = previewGlobalUnpublish(deps, {
        kind: requirePublicationKind(params),
        id: requireString(params, 'id'),
      })
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'definition.global.write',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    case 'planApprove': {
      const preview = previewTeamPlanApproval(runtime, { planId: requireString(params, 'planId') })
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'plan.approve',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    case 'teamDisband': {
      const preview = previewTeamDisband(runtime, { teamId: requireTeamId(params) })
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'team.disband',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    case 'captainTakeover': {
      const teamId = requireTeamId(params)
      const toSessionId = requireString(params, 'toSessionId')
      const preview = previewCaptainTakeover(runtime, { teamId, toSessionId })
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'captain.takeover',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    case 'planPropose':
    case 'planDiscard':
      fail(ERROR_CODES.INVALID_COMMAND, `${method} 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）`)
    case 'gateVerdict':
      fail(ERROR_CODES.INVALID_COMMAND, 'gateVerdict 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'taskCreate':
      fail(ERROR_CODES.INVALID_COMMAND, 'taskCreate 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'taskMove':
      fail(ERROR_CODES.INVALID_COMMAND, 'taskMove 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'teamCreate':
      fail(ERROR_CODES.INVALID_COMMAND, 'teamCreate 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'memberAppoint':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberAppoint 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'memberArchive':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberArchive 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'memberRestore':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberRestore 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'memberRelease':
      fail(ERROR_CODES.INVALID_COMMAND, 'memberRelease 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'memoryRemember':
    case 'memoryForget':
      fail(ERROR_CODES.INVALID_COMMAND, `${method} 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）`)
    case 'definitionSave':
      fail(ERROR_CODES.INVALID_COMMAND, 'definitionSave 不走确认令牌：直接带 confirm: true 提交（见 applyDirectPanelWrite）')
    case 'definitionPublish': {
      const preview = requestDefinitionPublication(runtime, { publisher: requirePublisher(deps) }, {
        actor: PANEL_HUMAN,
        kind: requirePublicationKind(params),
        id: requireString(params, 'id'),
      })
      const confirmation = authorizer.issue(
        {
          operationId: preview.operationId,
          action: 'definition.publish.confirm',
          targetHash: preview.targetHash,
          impactHash: preview.impactHash,
        },
        PANEL_HUMAN,
      )
      return { method, operationId: preview.operationId, summary: preview.summary, impact: preview.impact, confirmation }
    }
    default: {
      const exhaustive: never = method
      fail(ERROR_CODES.INVALID_COMMAND, `未实现的写方法：${String(exhaustive)}`)
    }
  }
}
