/**
 * 项目用例：初始化项目。
 *
 * 与其它命令模块同一纪律：只做「解析意图 → 领域校验 → 产出事件」，
 * 不碰文件、DSH 与面板协议。由 {@link ../commands.ts} 统一重导出。
 */
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import type { ActorRef } from '../../contracts/events.ts'
import type { CommitResult, DraftEvent, ProjectRuntime } from '../project-runtime.ts'

export function initializeProject(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; name: string },
): CommitResult {
  if (runtime.state.seq !== 0) {
    fail(ERROR_CODES.ALREADY_EXISTS, '项目已经初始化，不能重复初始化')
  }
  if (input.actor.kind === 'member') {
    fail(ERROR_CODES.FORBIDDEN, '成员不能初始化项目')
  }
  const now = runtime.now()
  const draft: DraftEvent = {
    type: 'project.initialized',
    actor: input.actor,
    entity: { kind: 'project', id: runtime.projectId },
    payload: { name: input.name.trim(), createdAt: now },
  }
  return runtime.commit([draft])
}
