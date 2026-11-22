/**
 * 知识用例：提案、采纳、归档。
 *
 * 知识是**项目事件**，Markdown 只是生成视图。三条规则：
 *   - 证据必填：没有可追溯证据的「经验」会变成不可反驳的传言；
 *   - 提案与采纳分离：成员只能提案，队长/人才能采纳；
 *   - 修订通过新事件完成，旧断言不被静默覆盖（`supersedes` 留链）。
 */
import type { EvidenceRef, KnowledgeEntry } from '../contracts/entities.ts'
import { ERROR_CODES, fail } from '../contracts/errors.ts'
import type { ActorRef } from '../contracts/events.ts'
import { authorize } from '../domain/permissions/policy.ts'
import type { CommitResult, DraftEvent, ProjectRuntime } from './project-runtime.ts'

export function proposeKnowledgeCommand(
  runtime: ProjectRuntime,
  input: {
    actor: ActorRef
    title: string
    body: string
    evidence: EvidenceRef[]
    supersedes?: string | null
  },
): CommitResult {
  authorize('knowledge.propose', input.actor)
  if (input.title.trim().length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '知识标题不能为空')
  }
  if (input.body.trim().length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '知识正文不能为空')
  }
  if (input.evidence.length === 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, '知识提案必须附带证据')
  }

  const state = runtime.state
  if (input.supersedes !== undefined && input.supersedes !== null && !state.knowledge.has(input.supersedes)) {
    fail(ERROR_CODES.NOT_FOUND, '被修订的知识条目不存在', { details: { entryId: input.supersedes } })
  }

  const now = runtime.now()
  const entry: KnowledgeEntry = {
    id: runtime.nextId('knowledge'),
    title: input.title.trim(),
    body: input.body,
    evidence: input.evidence,
    status: 'proposed',
    supersedes: input.supersedes ?? null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }

  const draft: DraftEvent = {
    type: 'knowledge.proposed',
    actor: input.actor,
    entity: { kind: 'knowledge-entry', id: entry.id },
    entityRevision: 1,
    payload: { entry },
  }
  return runtime.commit([draft])
}

function requireEntry(runtime: ProjectRuntime, entryId: string): KnowledgeEntry {
  const entry = runtime.state.knowledge.get(entryId)
  if (entry === undefined) {
    fail(ERROR_CODES.NOT_FOUND, '知识条目不存在', { details: { entryId } })
  }
  return entry
}

export function adoptKnowledgeCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; entryId: string },
): CommitResult {
  authorize('knowledge.adopt', input.actor)
  const entry = requireEntry(runtime, input.entryId)
  if (entry.status !== 'proposed') {
    fail(ERROR_CODES.INVALID_TRANSITION, `知识条目状态为 ${entry.status}，不能采纳`, {
      details: { entryId: entry.id, status: entry.status },
    })
  }

  const revision = entry.revision + 1
  const draft: DraftEvent = {
    type: 'knowledge.adopted',
    actor: input.actor,
    entity: { kind: 'knowledge-entry', id: entry.id },
    entityRevision: revision,
    payload: {
      entryId: entry.id,
      revision,
      adoptedBy: input.actor.kind === 'human' ? input.actor.userId : input.actor.kind,
    },
  }
  return runtime.commit([draft])
}

export function archiveKnowledgeCommand(
  runtime: ProjectRuntime,
  input: { actor: ActorRef; entryId: string },
): CommitResult {
  authorize('knowledge.archive', input.actor)
  const entry = requireEntry(runtime, input.entryId)
  if (entry.status === 'archived') {
    fail(ERROR_CODES.CONFLICT, '知识条目已归档', { details: { entryId: entry.id } })
  }

  const revision = entry.revision + 1
  const draft: DraftEvent = {
    type: 'knowledge.archived',
    actor: input.actor,
    entity: { kind: 'knowledge-entry', id: entry.id },
    entityRevision: revision,
    payload: { entryId: entry.id, revision },
  }
  return runtime.commit([draft])
}