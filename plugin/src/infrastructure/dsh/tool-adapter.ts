/**
 * 把 myteam 工具规格转换成 DSH `ToolDefinition` 的结构。
 *
 * 这是**唯一**知道 DSH 工具形状的地方（name/parameters/output/execute），
 * 应用层只提供纯规格。这样宿主 API 变化时只改这一处，工具语义不动。
 *
 * 错误处理：业务错误不抛给宿主，而是返回结构化 `{ ok:false, error }`。
 * 模型因此能看到 `code` 并据此改变行为，而不是只看到一段异常文本。
 */
import { toErrorShape } from '../../contracts/errors.ts'
import type { JsonValue } from '../../contracts/json.ts'
import type { MyTeamToolSpec, ToolRuntimeContext } from '../../application/tool-specs.ts'

/** DSH `ToolDefinition` 的最小结构；不 import 宿主包，避免装配层被宿主类型绑死。 */
export interface DshToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: JsonValue): unknown[]
  }
  execute(args: unknown, exec: DshToolRunContextLike): Promise<unknown>
}

export interface DshToolRunContextLike {
  agent?: { id: string }
  signal?: AbortSignal
}

export type ResolveRuntime = (sessionId: string) => Promise<ToolRuntimeContext>

export function toDshTool(spec: MyTeamToolSpec, resolve: ResolveRuntime): DshToolDefinitionLike {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: spec.outputSchema,
      // 工具输出对模型是文本：用紧凑 JSON，避免大段空白挤占上下文。
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.id
      if (sessionId === undefined || sessionId.length === 0) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '工具调用缺少会话身份', retryable: false } }
      }
      try {
        const context = await resolve(sessionId)
        return await spec.execute(args, context)
      } catch (error) {
        return { ok: false, error: toErrorShape(error) }
      }
    },
  }
}